import Foundation
import ImageIO
import Vision

struct OcrOutput: Codable {
    let text: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty else {
    fail("empty image input")
}
guard let source = CGImageSourceCreateWithData(input as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("failed to decode image")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]

do {
    try VNImageRequestHandler(cgImage: image).perform([request])
} catch {
    fail("Vision OCR failed: \(error.localizedDescription)")
}

let observations = (request.results ?? []).sorted { left, right in
    let verticalDelta = abs(left.boundingBox.midY - right.boundingBox.midY)
    if verticalDelta > 0.02 {
        return left.boundingBox.midY > right.boundingBox.midY
    }
    return left.boundingBox.minX < right.boundingBox.minX
}
let text = observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")

do {
    let data = try JSONEncoder().encode(OcrOutput(text: text))
    FileHandle.standardOutput.write(data)
} catch {
    fail("failed to encode OCR output")
}
