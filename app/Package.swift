// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ClaudeGPTCompanion",
    platforms: [.macOS(.v26)],
    products: [.executable(name: "CompanionApp", targets: ["CompanionApp"])],
    targets: [
        .target(name: "CompanionCore"),
        .executableTarget(name: "CompanionApp", dependencies: ["CompanionCore"]),
        .testTarget(name: "CompanionCoreTests", dependencies: ["CompanionCore"]),
    ]
)
