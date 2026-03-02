// transcribe.swift — Background app that transcribes audio files
// Usage: transcribe <audio-file-path> <output-file-path>
// Writes transcribed text to the output file

import Cocoa
import Speech

class TranscribeDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        guard args.count > 2 else {
            try? "ERROR: Usage: transcribe <audio-file> <output-file>".write(toFile: args.count > 2 ? args[2] : "/tmp/transcribe-error.txt", atomically: true, encoding: .utf8)
            NSApp.terminate(nil)
            return
        }
        
        let audioPath = args[1]
        let outputPath = args[2]
        let fileURL = URL(fileURLWithPath: audioPath)
        
        guard FileManager.default.fileExists(atPath: audioPath) else {
            try? "ERROR: File not found".write(toFile: outputPath, atomically: true, encoding: .utf8)
            NSApp.terminate(nil)
            return
        }
        
        // Timeout
        DispatchQueue.global().asyncAfter(deadline: .now() + 25) {
            try? "ERROR: Timeout".write(toFile: outputPath, atomically: true, encoding: .utf8)
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard status == .authorized else {
                try? "ERROR: Not authorized".write(toFile: outputPath, atomically: true, encoding: .utf8)
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }
            
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
                  recognizer.isAvailable else {
                try? "ERROR: Recognizer unavailable".write(toFile: outputPath, atomically: true, encoding: .utf8)
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }
            
            let request = SFSpeechURLRecognitionRequest(url: fileURL)
            if #available(macOS 13, *) {
                request.addsPunctuation = true
            }
            
            recognizer.recognitionTask(with: request) { result, error in
                if let error = error {
                    try? "ERROR: \(error.localizedDescription)".write(toFile: outputPath, atomically: true, encoding: .utf8)
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                    return
                }
                
                guard let result = result, result.isFinal else { return }
                
                try? result.bestTranscription.formattedString.write(toFile: outputPath, atomically: true, encoding: .utf8)
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited) // No dock icon, no menu
let delegate = TranscribeDelegate()
app.delegate = delegate
app.run()
