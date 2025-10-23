import { parseTrpcErrors, type TTrpcErrors } from '@/helpers/parse-trpc-errors';
import { useForm } from '@/hooks/use-form';
import { getTRPCClient } from '@/lib/trpc';
import {
  STORAGE_MAX_FILE_COUNT,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MAX_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  StorageOverflowAction,
  type TChannel,
  type TDiskMetrics,
  type TFile,
  type TJoinedEmoji,
  type TJoinedRole,
  type TRole,
  type TStorageSettings
} from '@sharkord/shared';
import { filesize } from 'filesize';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

export const useAdminGeneral = () => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [settings, setSettings] = useState({
    name: '',
    description: '',
    password: '',
    allowNewUsers: false
  });
  const [logo, setLogo] = useState<TFile | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const settings = await trpc.others.getSettings.query();

    setSettings({
      name: settings.name,
      description: settings.description ?? '',
      password: settings.password ?? '',
      allowNewUsers: settings.allowNewUsers ?? false
    });
    setLoading(false);
    setLogo(settings.logo);
  }, []);

  const submit = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      await trpc.others.updateSettings.mutate({
        name: settings.name,
        description: settings.description,
        password: settings.password || undefined,
        allowNewUsers: settings.allowNewUsers
      });
      toast.success('Settings updated');
    } catch (error) {
      console.error('Error updating settings:', error);
      setErrors(parseTrpcErrors(error));
    }
  }, [settings]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onChange = useCallback((field: keyof typeof settings, value: any) => {
    setSettings((s) => ({ ...s, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return {
    settings,
    refetch: fetchSettings,
    loading,
    submit,
    errors,
    onChange,
    logo
  };
};

export const useAdminChannelGeneral = (channelId: number) => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [channel, setChannel] = useState<TChannel | undefined>(undefined);

  const fetchChannel = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const channel = await trpc.channels.get.query({ channelId });

    setChannel(channel);
    setLoading(false);
  }, [channelId]);

  const submit = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      await trpc.channels.update.mutate({
        channelId,
        name: channel?.name ?? '',
        topic: channel?.topic ?? null
      });

      toast.success('Channel updated');
    } catch (error) {
      console.error('Error updating channel:', error);
      setErrors(parseTrpcErrors(error));
    }
  }, [channel, channelId]);

  const onChange = useCallback(
    (field: keyof TChannel, value: string | null) => {
      if (!channel) return;
      setChannel((c) => (c ? { ...c, [field]: value } : c));
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    [channel]
  );

  useEffect(() => {
    fetchChannel();
  }, [fetchChannel]);

  return {
    channel,
    refetch: fetchChannel,
    loading,
    errors,
    onChange,
    submit
  };
};

export const useAdminEmojis = () => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [emojis, setEmojis] = useState<TJoinedEmoji[]>([]);

  const fetchEmojis = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const emojis = await trpc.emojis.getAll.query();

    setEmojis(emojis);
    setLoading(false);
  }, []);

  const onChange = useCallback(
    (field: keyof TJoinedEmoji, value: string | null) => {
      if (!emojis) return;

      setEmojis((c) => (c ? { ...c, [field]: value } : c));
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    [emojis]
  );

  useEffect(() => {
    fetchEmojis();
  }, [fetchEmojis]);

  return {
    emojis,
    refetch: fetchEmojis,
    loading,
    errors,
    onChange
  };
};

export const useAdminRoles = () => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [roles, setRoles] = useState<TJoinedRole[]>([]);

  const fetchRoles = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const roles = await trpc.roles.getAll.query();

    setRoles(roles);
    setLoading(false);
  }, []);

  const onChange = useCallback(
    (field: keyof TRole, value: string | null) => {
      if (!roles) return;

      setRoles((c) => (c ? { ...c, [field]: value } : c));
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    [roles]
  );

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  return {
    roles,
    refetch: fetchRoles,
    loading,
    errors,
    onChange
  };
};

export const useAdminStorage = () => {
  const [loading, setLoading] = useState(true);
  const { values, setValues, setTrpcErrors, r, onChange } =
    useForm<TStorageSettings>({
      storageOverflowAction: STORAGE_OVERFLOW_ACTION,
      storageSpaceQuotaByUser: STORAGE_MAX_QUOTA_PER_USER,
      storageUploadEnabled: true,
      storageUploadMaxFileCount: STORAGE_MAX_FILE_COUNT,
      storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE
    });
  const [diskMetrics, setDiskMetrics] = useState<TDiskMetrics | undefined>(
    undefined
  );

  const fetchStorageSettings = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const { storageSettings, diskMetrics } =
      await trpc.others.getStorageSettings.query();

    setValues(storageSettings);
    setDiskMetrics(diskMetrics);
    setLoading(false);
  }, [setValues]);

  const submit = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      await trpc.others.updateSettings.mutate({
        storageUploadEnabled: values.storageUploadEnabled,
        storageUploadMaxFileSize: values.storageUploadMaxFileSize,
        storageUploadMaxFileCount: values.storageUploadMaxFileCount,
        storageSpaceQuotaByUser: values.storageSpaceQuotaByUser,
        storageOverflowAction:
          values.storageOverflowAction as StorageOverflowAction
      });
      toast.success('Storage settings updated');
    } catch (error) {
      console.error('Error updating storage settings:', error);
      setTrpcErrors(error);
    }
  }, [values, setTrpcErrors]);

  const labels = useMemo(() => {
    return {
      storageUploadMaxFileSize: filesize(
        Number(values.storageUploadMaxFileSize ?? 0),
        {
          output: 'object',
          standard: 'jedec'
        }
      ),
      storageUploadMaxFileCount: values.storageUploadMaxFileCount,
      storageSpaceQuotaByUser: filesize(
        Number(values.storageSpaceQuotaByUser ?? 0),
        {
          output: 'object',
          standard: 'jedec'
        }
      )
    };
  }, [values]);

  useEffect(() => {
    fetchStorageSettings();
  }, [fetchStorageSettings]);

  return {
    values,
    labels,
    refetch: fetchStorageSettings,
    loading,
    submit,
    r,
    onChange,
    diskMetrics
  };
};
