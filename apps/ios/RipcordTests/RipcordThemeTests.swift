import SwiftUI
import UIKit
import XCTest

@testable import Ripcord

final class RipcordThemeTests: XCTestCase {
  private let appearances: [(String, UIUserInterfaceStyle, UIAccessibilityContrast)] = [
    ("light", .light, .normal), ("dark", .dark, .normal),
    ("light increased contrast", .light, .high), ("dark increased contrast", .dark, .high),
  ]

  private var surfaces: [(String, Color)] {
    [
      ("background", RipcordTheme.background), ("sidebar", RipcordTheme.sidebar),
      ("surface", RipcordTheme.surface), ("raised", RipcordTheme.raised),
    ]
  }

  @MainActor
  func testSemanticForegroundsMeetContrastOnEveryNeutralSurface() {
    let foregrounds: [(String, Color)] = [
      ("text", RipcordTheme.text), ("muted", RipcordTheme.muted),
      ("accent", RipcordTheme.accent), ("online", RipcordTheme.online),
      ("danger", RipcordTheme.danger), ("liveScreen", RipcordTheme.liveScreen),
    ]
    for (appearance, style, contrast) in appearances {
      let traits = traits(style, contrast)
      let minimum = contrast == .high ? 7.0 : 4.5
      for (foregroundName, foreground) in foregrounds {
        for (surfaceName, surface) in surfaces {
          XCTAssertGreaterThanOrEqual(
            ratio(foreground, surface, traits), minimum,
            "\(appearance): \(foregroundName) on \(surfaceName)")
        }
      }
    }
  }

  @MainActor
  func testFilledControlsAndDangerCalloutsHaveExplicitReadableForegrounds() {
    let pairs: [(String, Color, Color)] = [
      ("accent button", RipcordTheme.onAccent, RipcordTheme.accent),
      ("danger button", RipcordTheme.onDanger, RipcordTheme.danger),
      ("selected control", RipcordTheme.onSelectedControl, RipcordTheme.text),
      ("danger callout", RipcordTheme.danger, RipcordTheme.dangerSurface),
    ]
    for (appearance, style, contrast) in appearances {
      for (name, foreground, background) in pairs {
        XCTAssertGreaterThanOrEqual(
          ratio(foreground, background, traits(style, contrast)), contrast == .high ? 7 : 4.5,
          "\(appearance): \(name)")
      }
    }
  }

  @MainActor
  func testLiveBadgeContrastIncludesItsTranslucentTint() {
    for (appearance, style, contrast) in appearances {
      let traits = traits(style, contrast)
      let foreground = rgb(RipcordTheme.liveScreen, traits)
      for (surfaceName, surface) in surfaces {
        let background = rgb(surface, traits)
        // The rendered badge uses liveScreen.opacity(0.15) over its containing surface.
        let tinted = zip(foreground, background).map { $0 * 0.15 + $1 * 0.85 }
        XCTAssertGreaterThanOrEqual(
          ratio(foreground, tinted), contrast == .high ? 7 : 4.5,
          "\(appearance): live badge over \(surfaceName)")
      }
    }
  }

  @MainActor
  func testBoundariesRemainVisibleAndIncreaseWithContrast() {
    for style in [UIUserInterfaceStyle.light, .dark] {
      for (surfaceName, surface) in surfaces {
        let normal = ratio(RipcordTheme.border, surface, traits(style, .normal))
        let increased = ratio(RipcordTheme.border, surface, traits(style, .high))
        XCTAssertGreaterThanOrEqual(normal, 3, surfaceName)
        XCTAssertGreaterThanOrEqual(increased, 4.5, surfaceName)
        XCTAssertGreaterThan(increased, normal, surfaceName)
      }
    }
  }

  @MainActor
  func testAvatarPaletteKeepsWhiteInitialsReadableAndColorsStable() {
    XCTAssertEqual(RipcordTheme.avatarColors.count, 8)
    for (index, color) in RipcordTheme.avatarColors.enumerated() {
      let baseline = rgb(color, traits(.dark, .normal))
      for (appearance, style, contrast) in appearances {
        let traits = traits(style, contrast)
        XCTAssertGreaterThanOrEqual(
          ratio(.white, color, traits), 4.5, "avatar \(index): \(appearance)")
        XCTAssertEqual(rgb(color, traits), baseline, "avatar \(index): \(appearance)")
      }
    }
  }

  @MainActor
  func testPublicTokensResolveToDifferentSystemAppearances() {
    for (_, color) in surfaces + [("text", RipcordTheme.text), ("accent", RipcordTheme.accent)] {
      XCTAssertNotEqual(rgb(color, traits(.light, .normal)), rgb(color, traits(.dark, .normal)))
    }
    for color in [RipcordTheme.text, RipcordTheme.muted, RipcordTheme.accent, RipcordTheme.border] {
      for style in [UIUserInterfaceStyle.light, .dark] {
        XCTAssertNotEqual(rgb(color, traits(style, .normal)), rgb(color, traits(style, .high)))
      }
    }
  }

  private func traits(_ style: UIUserInterfaceStyle, _ contrast: UIAccessibilityContrast)
    -> UITraitCollection
  {
    UITraitCollection {
      $0.userInterfaceStyle = style
      $0.accessibilityContrast = contrast
      $0.displayGamut = .SRGB
    }
  }

  @MainActor
  private func rgb(_ color: Color, _ traits: UITraitCollection) -> [Double] {
    let resolved = UIColor(color).resolvedColor(with: traits)
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    XCTAssertTrue(resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
    XCTAssertEqual(alpha, 1, accuracy: 0.0001, "Contrast contracts require opaque tokens")
    return [Double(red), Double(green), Double(blue)]
  }

  @MainActor
  private func ratio(_ foreground: Color, _ background: Color, _ traits: UITraitCollection)
    -> Double
  {
    ratio(rgb(foreground, traits), rgb(background, traits))
  }

  private func ratio(_ foreground: [Double], _ background: [Double]) -> Double {
    let first = luminance(foreground)
    let second = luminance(background)
    return (max(first, second) + 0.05) / (min(first, second) + 0.05)
  }

  private func luminance(_ rgb: [Double]) -> Double {
    zip(rgb, [0.2126, 0.7152, 0.0722]).reduce(0) { result, pair in
      let (channel, weight) = pair
      let linear = channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
      return result + linear * weight
    }
  }
}
