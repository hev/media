import AppKit

func arguments(_ raw: String) -> [String]? {
    // Reject escaping, queries, userinfo, fragments and ambiguous URL forms.
    let pattern = #"^hevmedia://resolve/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/([1-9][0-9]{0,5})$"#
    guard let expression = try? NSRegularExpression(pattern: pattern),
          let match = expression.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
          match.range.length == raw.utf16.count else { return nil }
    return (1...2).compactMap { Range(match.range(at: $0), in: raw).map { String(raw[$0]) } }
}
func launch(_ raw: String) -> Bool {
    guard let args = arguments(raw) else { return false }
    let process = Process()
    process.executableURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/resolve-open")
    process.arguments = args
    do { try process.run(); process.waitUntilExit(); return process.terminationStatus == 0 }
    catch { return false }
}
class Delegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if !launch(url.absoluteString) {
                let alert = NSAlert(); alert.messageText = "Could not open Resolve project"
                alert.informativeText = "Check that the project is ready and the mini is reachable. Files land in ~/Movies/hev-video/."
                alert.runModal()
            }
        }
        application.terminate(nil)
    }
}
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--validate" {
    exit(arguments(CommandLine.arguments[2]) == nil ? 2 : 0)
}
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--url" {
    exit(launch(CommandLine.arguments[2]) ? 0 : 2)
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.run()
