// PoC (throwaway): confirm modern on-device speech APIs compile and report availability.
import Foundation
import Speech
import AVFoundation

@main struct Check {
  static func main() async {
    print("SpeechTranscriber.isAvailable:", SpeechTranscriber.isAvailable)
    let locales = await SpeechTranscriber.supportedLocales
    print("supported locales:", locales.count, "en-US:", locales.contains { $0.identifier(.bcp47) == "en-US" })
    let installed = await SpeechTranscriber.installedLocales
    print("installed locales:", installed.map { $0.identifier(.bcp47) })
    print("legacy SFSpeechRecognizer on-device:", SFSpeechRecognizer(locale: Locale(identifier: "en-US"))?.supportsOnDeviceRecognition ?? false)
    let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
    print("English TTS voices:", voices.count, "premium/enhanced:", voices.filter { $0.quality != .default }.count)
  }
}
