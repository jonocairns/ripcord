import {
  StorageOverflowAction,
  type TFile,
  type TTempFile
} from '@sharkord/shared';
import { randomUUIDv7 } from 'bun';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';
import { db } from '../db';
import { removeFile } from '../db/mutations/files';
import { getExceedingOldFiles, getUsedFileQuota } from '../db/queries/files';
import { getSettings } from '../db/queries/server';
import { getStorageUsageByUserId } from '../db/queries/users';
import { files } from '../db/schema';
import { PUBLIC_PATH, TMP_PATH, UPLOADS_PATH } from '../helpers/paths';

/**
 * Files workflow:
 * 1. User uploads file via HTTP -> stored as temporary file in UPLOADS_PATH
 * 2. addTemporaryFile is called to move file to a managed temporary location in TMP_PATH
 * 3. Temporary file is tracked and auto-deleted after TTL
 * 4. When user confirms/save, saveFile is called to move file to PUBLIC_PATH and create DB entry
 * 5. Storage limits are checked before finalizing save
 */

const TEMP_FILE_TTL = 1000 * 60 * 1; // 1 minute
const TEMP_MAX_FILES_PER_USER = 256;
const TEMP_MAX_FILES_GLOBAL = 2048;
const TEMP_MAX_USER_BYTES_MULTIPLIER = 1;
const TEMP_MAX_GLOBAL_BYTES_MULTIPLIER = 4;
const MAX_EXTENSION_LENGTH = 16;
const MAX_BASE_NAME_LENGTH = 120;
const UNSAFE_FILE_NAME_CHARS = /[<>:"/\\|?*]/g;
const WINDOWS_RESERVED_BASE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

class TemporaryFileCapacityError extends Error {}

const stripControlChars = (value: string): string =>
  Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);

      return code >= 32 && code !== 127;
    })
    .join('');

const sanitizeBaseName = (baseName: string): string => {
  const normalized = stripControlChars(baseName.normalize('NFKC'))
    .replace(UNSAFE_FILE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .replace(/^\.+$/, '')
    .slice(0, MAX_BASE_NAME_LENGTH);

  const fallback = normalized || 'file';

  if (WINDOWS_RESERVED_BASE_NAMES.test(fallback)) {
    return `${fallback}-file`;
  }

  return fallback;
};

const sanitizeExtension = (extension: string): string => {
  const normalized = stripControlChars(extension.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '')
    .slice(0, MAX_EXTENSION_LENGTH);

  return /^\.[a-z0-9]+$/.test(normalized) ? normalized : '';
};

const sanitizeOriginalName = (originalName: string): string => {
  const normalized = stripControlChars(originalName.normalize('NFKC')).trim();
  const basePath = path.basename(normalized.replace(/\\/g, '/'));
  const rawExtension = path.extname(basePath);
  const extension = sanitizeExtension(rawExtension);
  const baseName = sanitizeBaseName(path.basename(basePath, rawExtension));

  return `${baseName}${extension}`;
};

const md5File = async (path: string): Promise<string> => {
  const file = await fs.readFile(path);
  const hash = createHash('md5');

  hash.update(file);

  return hash.digest('hex');
};

const moveFile = async (src: string, dest: string) => {
  try {
    await fs.rename(src, dest);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    } else {
      throw err;
    }
  }
};

class TemporaryFileManager {
  private temporaryFiles: TTempFile[] = [];
  private timeouts: {
    [id: string]: NodeJS.Timeout;
  } = {};

  private pruneMissingTemporaryFiles = async (): Promise<void> => {
    const existingFiles = await Promise.all(
      this.temporaryFiles.map(async (file) => {
        try {
          await fs.access(file.path);
          return file;
        } catch {
          clearTimeout(this.timeouts[file.id]);
          delete this.timeouts[file.id];
          return undefined;
        }
      })
    );

    this.temporaryFiles = existingFiles.filter(
      (file): file is TTempFile => file !== undefined
    );
  };

  private assertWithinTemporaryCapacity = async (
    size: number,
    userId: number
  ): Promise<void> => {
    await this.pruneMissingTemporaryFiles();

    const settings = await getSettings();
    const totalFileCount = this.temporaryFiles.length;
    const userFiles = this.temporaryFiles.filter(
      (file) => file.userId === userId
    );
    const userFileCount = userFiles.length;

    if (
      totalFileCount >= TEMP_MAX_FILES_GLOBAL ||
      userFileCount >= TEMP_MAX_FILES_PER_USER
    ) {
      throw new TemporaryFileCapacityError(
        'Too many temporary uploads in progress'
      );
    }

    const totalBytes = this.temporaryFiles.reduce(
      (sum, file) => sum + file.size,
      0
    );
    const userBytes = userFiles.reduce((sum, file) => sum + file.size, 0);
    const maxUploadSize = Math.max(settings.storageUploadMaxFileSize, 1);
    const globalByteLimit = maxUploadSize * TEMP_MAX_GLOBAL_BYTES_MULTIPLIER;
    const userByteLimit = maxUploadSize * TEMP_MAX_USER_BYTES_MULTIPLIER;

    if (
      totalBytes + size > globalByteLimit ||
      userBytes + size > userByteLimit
    ) {
      throw new TemporaryFileCapacityError(
        'Temporary upload storage limit exceeded'
      );
    }
  };

  public getTemporaryFile = (id: string): TTempFile | undefined => {
    return this.temporaryFiles.find((file) => file.id === id);
  };

  public temporaryFileExists = (id: string): boolean => {
    return !!this.temporaryFiles.find((file) => file.id === id);
  };

  public addTemporaryFile = async ({
    filePath,
    size,
    originalName,
    userId
  }: {
    filePath: string;
    size: number;
    originalName: string;
    userId: number;
  }): Promise<TTempFile> => {
    const safeOriginalName = sanitizeOriginalName(originalName);
    await this.assertWithinTemporaryCapacity(size, userId);

    const md5 = await md5File(filePath);
    const fileId = randomUUIDv7();
    const ext = sanitizeExtension(path.extname(safeOriginalName));

    const tempFilePath = path.join(TMP_PATH, `${fileId}${ext}`);

    const tempFile: TTempFile = {
      id: fileId,
      originalName: safeOriginalName,
      size,
      md5,
      path: tempFilePath,
      extension: ext,
      userId
    };

    await moveFile(filePath, tempFile.path);

    this.temporaryFiles.push(tempFile);

    this.timeouts[tempFile.id] = setTimeout(() => {
      this.removeTemporaryFile(tempFile.id);
    }, TEMP_FILE_TTL);

    return tempFile;
  };

  public removeTemporaryFile = async (
    id: string,
    skipDelete = false
  ): Promise<void> => {
    const tempFile = this.temporaryFiles.find((file) => file.id === id);

    if (!tempFile) {
      throw new Error('Temporary file not found');
    }

    clearTimeout(this.timeouts[id]);

    if (!skipDelete) {
      try {
        await fs.unlink(tempFile.path);
      } catch {
        // ignore
      }
    }

    this.temporaryFiles = this.temporaryFiles.filter((file) => file.id !== id);
    delete this.timeouts[id];
  };

  public getSafeUploadPath = async (name: string): Promise<string> => {
    const safeOriginalName = sanitizeOriginalName(name);
    const ext = sanitizeExtension(path.extname(safeOriginalName));
    const safePath = path.join(UPLOADS_PATH, `${randomUUIDv7()}${ext}`);

    return safePath;
  };

  // Deletes files in a directory that are older than maxAgeMs.
  // Called at startup to recover files orphaned by a previous crash.
  private cleanupDirectory = async (
    dir: string,
    maxAgeMs: number
  ): Promise<void> => {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return; // directory doesn't exist yet
    }

    const now = Date.now();

    await Promise.allSettled(
      entries.map(async (name) => {
        const filePath = path.join(dir, name);
        try {
          const { mtimeMs } = await fs.stat(filePath);
          if (now - mtimeMs > maxAgeMs) {
            await fs.unlink(filePath);
          }
        } catch {
          // ignore — file may have been deleted concurrently
        }
      })
    );
  };

  public cleanupStaleFiles = async (): Promise<void> => {
    // At boot there are no active uploads or sessions, so all temp files are
    // stale. Using 0 avoids orphaning files younger than TEMP_FILE_TTL that
    // survived a crash (they'd never be registered in-memory and would persist
    // on disk indefinitely).
    await Promise.all([
      this.cleanupDirectory(UPLOADS_PATH, 0),
      this.cleanupDirectory(TMP_PATH, 0)
    ]);
  };
}

class FileManager {
  private tempFileManager = new TemporaryFileManager();

  public getSafeUploadPath = this.tempFileManager.getSafeUploadPath;

  public addTemporaryFile = this.tempFileManager.addTemporaryFile;

  public removeTemporaryFile = this.tempFileManager.removeTemporaryFile;

  public getTemporaryFile = this.tempFileManager.getTemporaryFile;
  public temporaryFileExists = this.tempFileManager.temporaryFileExists;
  public initialize = this.tempFileManager.cleanupStaleFiles;

  private handleStorageLimits = async (tempFile: TTempFile) => {
    const [settings, userStorage, serverStorage] = await Promise.all([
      getSettings(),
      getStorageUsageByUserId(tempFile.userId),
      getUsedFileQuota()
    ]);

    const newTotalStorage = userStorage.usedStorage + tempFile.size;

    if (
      settings.storageSpaceQuotaByUser > 0 &&
      newTotalStorage > settings.storageSpaceQuotaByUser
    ) {
      throw new Error('User storage limit exceeded');
    }

    const newServerStorage = serverStorage + tempFile.size;

    if (settings.storageQuota > 0 && newServerStorage > settings.storageQuota) {
      if (
        settings.storageOverflowAction === StorageOverflowAction.PREVENT_UPLOADS
      ) {
        throw new Error('Server storage limit exceeded.');
      }

      if (
        settings.storageOverflowAction ===
        StorageOverflowAction.DELETE_OLD_FILES
      ) {
        const filesToDelete = await getExceedingOldFiles(tempFile.size);

        const promises = filesToDelete.map(async (file) => {
          await removeFile(file.id);
        });

        await Promise.all(promises);
      }
    }
  };

  private getUniqueName = async (originalName: string): Promise<string> => {
    const safeOriginalName = sanitizeOriginalName(originalName);
    const rawExtension = path.extname(safeOriginalName);
    const extension = sanitizeExtension(rawExtension);
    const baseName = sanitizeBaseName(
      path.basename(safeOriginalName, rawExtension)
    );

    let fileName = `${baseName}${extension}`;
    let counter = 2;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existingFile = await db
        .select()
        .from(files)
        .where(eq(files.name, fileName))
        .get();

      if (!existingFile) {
        break;
      }

      fileName = `${baseName}-${counter}${extension}`;
      counter++;
    }

    return fileName;
  };

  public async saveFile(tempFileId: string, userId: number): Promise<TFile> {
    const tempFile = this.getTemporaryFile(tempFileId);

    if (!tempFile) {
      throw new Error('File not found');
    }

    if (tempFile.userId !== userId) {
      throw new Error("You don't have permission to access this file");
    }

    await this.handleStorageLimits(tempFile);

    const fileName = await this.getUniqueName(tempFile.originalName);
    const destinationPath = path.join(PUBLIC_PATH, fileName);

    await moveFile(tempFile.path, destinationPath);
    await this.removeTemporaryFile(tempFileId, true);

    const bunFile = Bun.file(destinationPath);

    return db
      .insert(files)
      .values({
        name: fileName,
        extension: tempFile.extension,
        md5: tempFile.md5,
        size: tempFile.size,
        originalName: tempFile.originalName,
        userId,
        mimeType: bunFile?.type || 'application/octet-stream',
        createdAt: Date.now()
      })
      .returning()
      .get();
  }
}

const fileManager = new FileManager();

export { fileManager, TemporaryFileCapacityError };
