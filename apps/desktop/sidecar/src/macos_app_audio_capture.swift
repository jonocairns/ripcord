import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

private enum AudioOutputConstants {
    static let sampleRate: Double = 48_000
    static let channelCount: AVAudioChannelCount = 1
    static let framesPerPacket = 960
}

private struct AudioTarget: Codable {
    let id: String
    let label: String
    let pid: Int32
    let processName: String
}

private struct TargetListResponse: Codable {
    let targets: [AudioTarget]
}

private struct ResolveSourceResponse: Codable {
    let sourceId: String
    let pid: Int32?
}

private enum HelperError: Error, CustomStringConvertible {
    case usage(String)
    case unsupportedPlatform
    case missingDisplay
    case targetNotFound(Int32)
    case invalidSourceID(String)
    case outputUnavailable
    case invalidAudioFormat(String)
    case conversionFailed(String)
    case ioFailure(String)

    var description: String {
        switch self {
        case let .usage(message):
            return message
        case .unsupportedPlatform:
            return "ScreenCaptureKit audio capture requires macOS 13 or newer."
        case .missingDisplay:
            return "No shareable display was available for ScreenCaptureKit."
        case let .targetNotFound(pid):
            return "No shareable application with pid \(pid) is available for audio capture."
        case let .invalidSourceID(sourceID):
            return "Unsupported or invalid source ID: \(sourceID)"
        case let .outputUnavailable:
            return "Failed to access standard output for audio capture."
        case let .invalidAudioFormat(message):
            return "Unsupported audio sample format: \(message)"
        case let .conversionFailed(message):
            return "Failed to convert ScreenCaptureKit audio sample: \(message)"
        case let .ioFailure(message):
            return "Failed writing captured audio packet: \(message)"
        }
    }
}

private enum Command {
    case listTargets
    case resolveSource(sourceID: String)
    case capture(sourceID: String?, targetPID: Int32?, excludePID: Int32?)
}

private func parseCommand(arguments: [String]) throws -> Command {
    guard arguments.count >= 2 else {
        throw HelperError.usage(
            "Usage: sharkord-capture-sidecar-macos-helper <list-targets|resolve-source --source-id <source>|capture [--source-id <source>] [--target-pid <pid>] [--exclude-pid <pid>]>"
        )
    }

    switch arguments[1] {
    case "list-targets":
        return .listTargets
    case "resolve-source":
        var index = 2
        var sourceID: String?

        while index < arguments.count {
            let token = arguments[index]
            switch token {
            case "--source-id":
                index += 1
                guard index < arguments.count else {
                    throw HelperError.usage("Missing value for --source-id.")
                }
                sourceID = arguments[index]
            default:
                throw HelperError.usage("Unknown argument: \(token)")
            }

            index += 1
        }

        guard let sourceID else {
            throw HelperError.usage("The resolve-source command requires --source-id <source>.")
        }

        return .resolveSource(sourceID: sourceID)
    case "capture":
        var index = 2
        var sourceID: String?
        var targetPID: Int32?
        var excludePID: Int32?

        while index < arguments.count {
            let token = arguments[index]
            switch token {
            case "--source-id":
                index += 1
                guard index < arguments.count else {
                    throw HelperError.usage("Missing value for --source-id.")
                }
                sourceID = arguments[index]
            case "--target-pid":
                index += 1
                guard index < arguments.count, let parsed = Int32(arguments[index]) else {
                    throw HelperError.usage("Missing or invalid value for --target-pid.")
                }
                targetPID = parsed
            case "--exclude-pid":
                index += 1
                guard index < arguments.count, let parsed = Int32(arguments[index]) else {
                    throw HelperError.usage("Missing or invalid value for --exclude-pid.")
                }
                excludePID = parsed
            default:
                throw HelperError.usage("Unknown argument: \(token)")
            }
            index += 1
        }

        if targetPID == nil, excludePID == nil {
            throw HelperError.usage("The capture command requires --target-pid <pid> or --exclude-pid <pid>.")
        }

        if targetPID != nil, excludePID != nil {
            throw HelperError.usage("Capture supports either --target-pid or --exclude-pid, not both.")
        }

        return .capture(sourceID: sourceID, targetPID: targetPID, excludePID: excludePID)
    default:
        throw HelperError.usage("Unknown command: \(arguments[1])")
    }
}

private enum ParsedSourceID {
    case screen(CGDirectDisplayID)
    case window(CGWindowID)
}

private func parseSourceID(_ sourceID: String) -> ParsedSourceID? {
    let components = sourceID.split(separator: ":")
    guard components.count >= 2 else {
        return nil
    }

    switch components[0] {
    case "screen":
        guard let rawDisplayID = UInt32(components[1]) else {
            return nil
        }
        return .screen(rawDisplayID)
    case "window":
        guard let rawWindowID = UInt32(components[1]) else {
            return nil
        }
        return .window(rawWindowID)
    default:
        return nil
    }
}

@available(macOS 13.0, *)
private func loadShareableContent() async throws -> SCShareableContent {
    return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
}

@available(macOS 13.0, *)
private func listTargets() async throws {
    let content = try await loadShareableContent()
    var dedupedTargets: [Int32: AudioTarget] = [:]

    for application in content.applications {
        let pid = application.processID
        guard pid > 0 else {
            continue
        }

        let applicationName = application.applicationName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !applicationName.isEmpty else {
            continue
        }

        let processName = application.bundleIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedProcessName = processName.isEmpty ? applicationName : processName

        dedupedTargets[pid] = AudioTarget(
            id: "pid:\(pid)",
            label: "\(applicationName) (\(pid))",
            pid: pid,
            processName: resolvedProcessName
        )
    }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let targets = dedupedTargets.values.sorted { left, right in
        if left.label == right.label {
            return left.pid < right.pid
        }
        return left.label.localizedCaseInsensitiveCompare(right.label) == .orderedAscending
    }

    let payload = try encoder.encode(TargetListResponse(targets: targets))
    FileHandle.standardOutput.write(payload)
}

@available(macOS 13.0, *)
private func chooseDisplay(from content: SCShareableContent, sourceID: String?) -> SCDisplay? {
    if let sourceID,
       let parsedSourceID = parseSourceID(sourceID),
       case let .screen(displayID) = parsedSourceID,
       let matchedDisplay = content.displays.first(where: { $0.displayID == displayID }) {
        return matchedDisplay
    }

    return content.displays.first
}

@available(macOS 13.0, *)
private func resolveSourcePID(from content: SCShareableContent, sourceID: String) -> Int32? {
    guard let parsedSourceID = parseSourceID(sourceID) else {
        return nil
    }

    switch parsedSourceID {
    case .screen:
        return nil
    case let .window(windowID):
        return content.windows
            .first(where: { $0.windowID == windowID })?
            .owningApplication?
            .processID
    }
}

@available(macOS 13.0, *)
private func resolveSource(sourceID: String) async throws {
    let content = try await loadShareableContent()
    let response = ResolveSourceResponse(
        sourceId: sourceID,
        pid: resolveSourcePID(from: content, sourceID: sourceID)
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let payload = try encoder.encode(response)
    FileHandle.standardOutput.write(payload)
}

private final class PacketWriter {
    private let fileHandle: FileHandle
    private var pendingSamples: [Float] = []

    init(fileHandle: FileHandle) {
        self.fileHandle = fileHandle
    }

    func append(from buffer: AVAudioPCMBuffer) throws {
        guard let channelData = buffer.floatChannelData?.pointee else {
            throw HelperError.invalidAudioFormat("Converted buffer did not expose floatChannelData.")
        }

        let frameLength = Int(buffer.frameLength)
        if frameLength <= 0 {
            return
        }

        pendingSamples.append(contentsOf: UnsafeBufferPointer(start: channelData, count: frameLength))
        try flushCompletePackets()
    }

    private func flushCompletePackets() throws {
        while pendingSamples.count >= AudioOutputConstants.framesPerPacket {
            let frameSamples = Array(pendingSamples.prefix(AudioOutputConstants.framesPerPacket))
            pendingSamples.removeFirst(AudioOutputConstants.framesPerPacket)
            try write(frameSamples: frameSamples)
        }
    }

    private func write(frameSamples: [Float]) throws {
        var payload = Data()
        payload.reserveCapacity(frameSamples.count * MemoryLayout<Float>.size)

        for sample in frameSamples {
            var sampleBits = sample.bitPattern.littleEndian
            withUnsafeBytes(of: &sampleBits) { payload.append(contentsOf: $0) }
        }

        var packet = Data()
        var payloadLength = UInt32(payload.count).littleEndian
        withUnsafeBytes(of: &payloadLength) { packet.append(contentsOf: $0) }
        packet.append(payload)

        do {
            try fileHandle.write(contentsOf: packet)
        } catch {
            throw HelperError.ioFailure(error.localizedDescription)
        }
    }
}

@available(macOS 13.0, *)
private final class AudioCaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let targetFormat: AVAudioFormat = AVAudioFormat(
        standardFormatWithSampleRate: AudioOutputConstants.sampleRate,
        channels: AudioOutputConstants.channelCount
    )!
    private let packetWriter: PacketWriter

    init(packetWriter: PacketWriter) {
        self.packetWriter = packetWriter
        super.init()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("[capture-sidecar-macos-helper] stream stopped: \(error.localizedDescription)\n", stderr)
        exit(1)
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio else {
            return
        }

        do {
            let convertedBuffer = try convert(sampleBuffer: sampleBuffer)
            try packetWriter.append(from: convertedBuffer)
        } catch {
            fputs("[capture-sidecar-macos-helper] \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    private func convert(sampleBuffer: CMSampleBuffer) throws -> AVAudioPCMBuffer {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else {
            throw HelperError.invalidAudioFormat("Missing audio format description.")
        }

        guard let sourceFormat = AVAudioFormat(streamDescription: streamDescription) else {
            throw HelperError.invalidAudioFormat("Could not create AVAudioFormat from sample description.")
        }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        if frameCount <= 0 {
            throw HelperError.invalidAudioFormat("Audio sample buffer contained no frames.")
        }

        let bufferListSize = MemoryLayout<AudioBufferList>.size +
            max(0, Int(sourceFormat.channelCount) - 1) * MemoryLayout<AudioBuffer>.size
        let rawBufferList = UnsafeMutableRawPointer.allocate(
            byteCount: bufferListSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer {
            rawBufferList.deallocate()
        }

        let audioBufferList = rawBufferList.bindMemory(to: AudioBufferList.self, capacity: 1)
        var blockBuffer: CMBlockBuffer?

        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioBufferList,
            bufferListSize: bufferListSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )

        guard status == noErr else {
            throw HelperError.invalidAudioFormat("CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer failed (\(status)).")
        }

        guard let sourceBuffer = AVAudioPCMBuffer(
            pcmFormat: sourceFormat,
            frameCapacity: AVAudioFrameCount(frameCount)
        ) else {
            throw HelperError.invalidAudioFormat("Failed to allocate source PCM buffer.")
        }
        sourceBuffer.frameLength = AVAudioFrameCount(frameCount)

        let capturedBuffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(sourceBuffer.mutableAudioBufferList)
        let bufferCount = min(capturedBuffers.count, destinationBuffers.count)

        for bufferIndex in 0..<bufferCount {
            let sourceAudioBuffer = capturedBuffers[bufferIndex]
            let byteCount = Int(sourceAudioBuffer.mDataByteSize)

            guard let sourceData = sourceAudioBuffer.mData,
                  let destinationData = destinationBuffers[bufferIndex].mData
            else {
                continue
            }

            memcpy(destinationData, sourceData, byteCount)
            destinationBuffers[bufferIndex].mDataByteSize = UInt32(byteCount)
        }

        if sourceFormat.sampleRate == targetFormat.sampleRate,
           sourceFormat.channelCount == targetFormat.channelCount,
           sourceFormat.commonFormat == targetFormat.commonFormat,
           sourceFormat.isInterleaved == targetFormat.isInterleaved
        {
            return sourceBuffer
        }

        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            throw HelperError.conversionFailed("AVAudioConverter initialization failed.")
        }

        let estimatedFrameCapacity = AVAudioFrameCount(
            ceil(Double(sourceBuffer.frameLength) * targetFormat.sampleRate / sourceFormat.sampleRate)
        ) + 64

        guard let convertedBuffer = AVAudioPCMBuffer(
            pcmFormat: targetFormat,
            frameCapacity: estimatedFrameCapacity
        ) else {
            throw HelperError.conversionFailed("Failed to allocate output PCM buffer.")
        }

        var didProvideInput = false
        var conversionError: NSError?
        let statusResult = converter.convert(to: convertedBuffer, error: &conversionError) { _, outStatus in
            if didProvideInput {
                outStatus.pointee = AVAudioConverterInputStatus.endOfStream
                return nil
            }

            didProvideInput = true
            outStatus.pointee = AVAudioConverterInputStatus.haveData
            return sourceBuffer
        }

        if let conversionError {
            throw HelperError.conversionFailed(conversionError.localizedDescription)
        }

        switch statusResult {
        case .haveData, .inputRanDry, .endOfStream:
            return convertedBuffer
        @unknown default:
            throw HelperError.conversionFailed("Unexpected AVAudioConverter output status.")
        }
    }
}

@available(macOS 13.0, *)
private func startCapture(sourceID: String?, targetPID: Int32?, excludePID: Int32?) async throws -> Never {
    let content = try await loadShareableContent()

    guard let display = chooseDisplay(from: content, sourceID: sourceID) else {
        throw HelperError.missingDisplay
    }

    let filter: SCContentFilter

    if let targetPID {
        guard let targetApplication = content.applications.first(where: { $0.processID == targetPID }) else {
            throw HelperError.targetNotFound(targetPID)
        }

        filter = SCContentFilter(display: display, including: [targetApplication], exceptingWindows: [])
    } else if let excludePID {
        let helperPID = Int32(ProcessInfo.processInfo.processIdentifier)
        let excludedProcessIDs = Set([excludePID, helperPID])
        let excludedApplications = content.applications.filter { excludedProcessIDs.contains($0.processID) }

        filter = SCContentFilter(display: display, excludingApplications: excludedApplications, exceptingWindows: [])
    } else {
        throw HelperError.usage("Capture requires a target or exclude pid.")
    }

    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = Int(AudioOutputConstants.sampleRate)
    configuration.channelCount = Int(AudioOutputConstants.channelCount)
    configuration.width = display.width
    configuration.height = display.height
    configuration.queueDepth = 3

    let packetWriter = PacketWriter(fileHandle: FileHandle.standardOutput)
    let output = AudioCaptureOutput(packetWriter: packetWriter)
    let outputQueue = DispatchQueue(label: "com.sharkord.sidecar.macos-audio")
    let stream = SCStream(filter: filter, configuration: configuration, delegate: output)

    try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: outputQueue)
    try await stream.startCapture()
    dispatchMain()
}

@main
private enum MacosAppAudioCaptureHelper {
    static func main() async {
        do {
            let command = try parseCommand(arguments: CommandLine.arguments)

            guard #available(macOS 13.0, *) else {
                throw HelperError.unsupportedPlatform
            }

            switch command {
            case .listTargets:
                try await listTargets()
            case let .resolveSource(sourceID):
                try await resolveSource(sourceID: sourceID)
            case let .capture(sourceID, targetPID, excludePID):
                _ = try await startCapture(sourceID: sourceID, targetPID: targetPID, excludePID: excludePID)
            }
        } catch {
            fputs("[capture-sidecar-macos-helper] \(error)\n", stderr)
            exit(1)
        }
    }
}
