// Signing credentials for releases, kept in the login keychain so nobody has to
// type, see or paste them. Run with `swift dev/signing.swift <command>`.
//
//   export [identity] [out.p12]
//     Export ONE Developer ID Application identity (certificate + private key)
//     as a .p12, protected by a generated password that is saved in the login
//     keychain (service "kehikot-signing", account "APPLE_CERTIFICATE_PASSWORD").
//     The identity is found by itself when there is exactly one; name it when
//     there are several. Out defaults to ~/Desktop/kehikot-developer-id.p12.
//
//   save-app-password
//     Ask for the Apple ID app-specific password used for notarization in a
//     hidden macOS dialog and save it (account "APPLE_PASSWORD").
//
// Why not `security export -t identities`: it exports every identity in the
// keychain and aborts on the first key that is not exportable — a VPN client's,
// for instance — so it cannot be used on an ordinary Mac. This asks for one.
//
// Then `dev/set-signing-secrets.sh` sends everything to GitHub. Renew every
// five years, when the Developer ID certificate expires: new certificate
// request in Keychain Access, new certificate at developer.apple.com, then
// these two scripts again.
import Foundation
import Security

let service = "kehikot-signing"

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func describe(_ status: OSStatus) -> String {
    SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
}

/// Save a secret as a generic password in the login keychain, replacing any old one.
func keep(_ account: String, _ value: String, label: String, comment: String) {
    let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
        kSecAttrLabel as String: label,
        kSecAttrComment as String: comment,
        kSecValueData as String: value.data(using: .utf8)!,
    ]
    var status = SecItemUpdate(item as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        status = SecItemAdd(item.merging(attributes) { $1 } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { fail("Could not save \(account) to the keychain: \(describe(status)).") }
}

/// A hidden-answer macOS dialog: works whether or not this runs in a terminal.
func ask(_ prompt: String) -> String {
    let script = """
    display dialog "\(prompt)" default answer "" with hidden answer ¬
      with title "Kehikot signing" buttons {"Cancel", "OK"} default button "OK" with icon caution
    text returned of result
    """
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    task.arguments = ["-e", script]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    do { try task.run() } catch { fail("Could not show the dialog.") }
    task.waitUntilExit()
    guard task.terminationStatus == 0 else { fail("Cancelled; nothing was saved.") }
    let raw = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return raw.trimmingCharacters(in: .whitespacesAndNewlines)
}

func generatedPassword() -> String {
    let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789")
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        fail("Could not generate a password.")
    }
    return String(bytes.map { alphabet[Int($0) % alphabet.count] })
}

/// Every identity whose certificate is a Developer ID Application, by label.
func developerIdentities() -> [(String, SecIdentity)] {
    var found: CFTypeRef?
    let query: [String: Any] = [
        kSecClass as String: kSecClassIdentity,
        kSecReturnRef as String: true,
        kSecReturnAttributes as String: true,
        kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
          let rows = found as? [[String: Any]] else { return [] }
    return rows.compactMap { row in
        guard let label = row[kSecAttrLabel as String] as? String,
              label.hasPrefix("Developer ID Application:"),
              let ref = row[kSecValueRef as String] else { return nil }
        return (label, ref as! SecIdentity)
    }
}

func export(_ args: [String]) {
    let all = developerIdentities()
    let chosen: (String, SecIdentity)
    if let wanted = args.first {
        guard let match = all.first(where: { $0.0 == wanted }) else {
            fail("No identity named \"\(wanted)\". Found: \(all.map { $0.0 }.joined(separator: ", ")).")
        }
        chosen = match
    } else {
        switch all.count {
        case 0: fail("No Developer ID Application identity in the keychain. Create the certificate first.")
        case 1: chosen = all[0]
        default: fail("Several Developer ID identities; name one:\n  " + all.map { $0.0 }.joined(separator: "\n  "))
        }
    }
    let out = args.count > 1
        ? URL(fileURLWithPath: (args[1] as NSString).expandingTildeInPath)
        : URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Desktop/kehikot-developer-id.p12")

    let password = generatedPassword()
    var params = SecItemImportExportKeyParameters()
    params.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
    params.passphrase = Unmanaged.passUnretained(password as CFString)
    var data: CFData?
    let status = SecItemExport(chosen.1, .formatPKCS12, [], &params, &data)
    guard status == errSecSuccess, let data else { fail("macOS refused to export it: \(describe(status)).") }

    // The password is saved before the file exists, so a .p12 never outlives its password.
    keep("APPLE_CERTIFICATE_PASSWORD", password,
         label: "Kehikot signing certificate (.p12) password",
         comment: "Password of \(out.path); the APPLE_CERTIFICATE_PASSWORD GitHub secret.")
    do {
        try (data as Data).write(to: out, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: out.path)
    } catch {
        fail("Could not write \(out.path): \(error.localizedDescription)")
    }
    print("Wrote \(out.path): \(chosen.0).")
    print("Its generated password is in your login keychain: \"Kehikot signing certificate (.p12) password\".")
}

func saveAppPassword() {
    let value = ask("Paste the app-specific password for notarization (from account.apple.com):")
    guard !value.isEmpty else { fail("Empty; nothing was saved.") }
    keep("APPLE_PASSWORD", value,
         label: "Kehikot notarization app-specific password",
         comment: "Apple ID app-specific password for notarytool; the APPLE_PASSWORD GitHub secret.")
    print("Saved to your login keychain: \"Kehikot notarization app-specific password\".")
}

let argv = Array(CommandLine.arguments.dropFirst())
switch argv.first {
case "export": export(Array(argv.dropFirst()))
case "save-app-password": saveAppPassword()
default: fail("usage: swift dev/signing.swift export [identity] [out.p12] | save-app-password")
}
