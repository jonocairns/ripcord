import SwiftUI
import UIKit

/// Semantic colors resolve against the current appearance and Increased Contrast setting.
/// Keep foreground/surface pairings here so every screen shares the same contrast contract.
enum RipcordTheme {
  static let background = adaptive(
    light: 0xF7F5FA, dark: 0x16151D, highLight: 0xFFFFFF, highDark: 0x100F16)
  static let sidebar = adaptive(
    light: 0xEFECF5, dark: 0x0E0D14, highLight: 0xF3EFF8, highDark: 0x08070D)
  static let surface = adaptive(
    light: 0xFFFFFF, dark: 0x1E1C25, highLight: 0xFFFFFF, highDark: 0x17151E)
  static let raised = adaptive(
    light: 0xE8E3F0, dark: 0x282531, highLight: 0xE7DFEF, highDark: 0x211E2A)

  // These foregrounds clear AA on all four neutral surfaces, including raised controls.
  static let text = adaptive(
    light: 0x252130, dark: 0xF4F3F8, highLight: 0x17121F, highDark: 0xFFFFFF)
  static let muted = adaptive(
    light: 0x645C70, dark: 0xADAAB6, highLight: 0x403548, highDark: 0xC8C4D2)
  static let accent = adaptive(
    light: 0x6332BD, dark: 0xA684FF, highLight: 0x4F209C, highDark: 0xC5ABFF)
  static let online = adaptive(
    light: 0x146B47, dark: 0x49C290, highLight: 0x075333, highDark: 0x75E5B1)
  static let danger = adaptive(
    light: 0xB32638, dark: 0xFF6467, highLight: 0x8C1329, highDark: 0xFF969A)
  static let dangerSurface = adaptive(
    light: 0xFCE9ED, dark: 0x4E1B27, highLight: 0xFCE9ED, highDark: 0x35121D)
  static let liveScreen = adaptive(
    light: 0x8B259F, dark: 0xED6BFF, highLight: 0x590A68, highDark: 0xF6BFFF)

  // Opaque boundaries remain at least 3:1 against neutral surfaces in either appearance.
  static let border = adaptive(
    light: 0x867C93, dark: 0x797280, highLight: 0x6C5F7A, highDark: 0x8B8599)

  // Inverted foregrounds are not surfaces: sidebar becomes light in light appearance.
  /// Foreground for a solid accent fill (send/sign-in buttons).
  static let onAccent = adaptive(
    light: 0xFFFFFF, dark: 0x0E0D14, highLight: 0xFFFFFF, highDark: 0x08070D)
  /// Foreground for a solid danger fill (leave-call buttons), not dangerSurface.
  static let onDanger = adaptive(
    light: 0xFFFFFF, dark: 0x0E0D14, highLight: 0xFFFFFF, highDark: 0x08070D)
  /// Foreground for selected controls whose fill is `text` (speaker output).
  static let onSelectedControl = adaptive(
    light: 0xFFFFFF, dark: 0x0E0D14, highLight: 0xFFFFFF, highDark: 0x08070D)

  // Match desktop's userId % 8 hues, with 700 shades for AA white initials.
  // Avatar fills and their white initials deliberately stay stable across appearances.
  static let avatarColors: [Color] = [
    Color(red: 0.779, green: 0, blue: 0.211),
    Color(red: 0.792, green: 0.207, blue: 0),
    Color(red: 0, green: 0.478, blue: 0.334),
    Color(red: 0, green: 0.412, blue: 0.660),
    Color(red: 0.440, green: 0.031, blue: 0.906),
    Color(red: 0.778, green: 0, blue: 0.359),
    Color(red: 0.264, green: 0.177, blue: 0.845),
    Color(red: 0, green: 0.469, blue: 0.435),
  ]

  private static func adaptive(light: UInt32, dark: UInt32, highLight: UInt32, highDark: UInt32)
    -> Color
  {
    Color(
      uiColor: UIColor { traits in
        let isDark = traits.userInterfaceStyle == .dark
        let highContrast = traits.accessibilityContrast == .high
        let rgb = highContrast ? (isDark ? highDark : highLight) : (isDark ? dark : light)
        return UIColor(
          red: CGFloat((rgb >> 16) & 0xFF) / 255,
          green: CGFloat((rgb >> 8) & 0xFF) / 255,
          blue: CGFloat(rgb & 0xFF) / 255,
          alpha: 1)
      })
  }
}
