import SwiftUI

struct MemberAvatar: View {
  let name: String
  let userId: Int
  var prominent = false
  @ScaledMetric(relativeTo: .body) private var size = 38
  @ScaledMetric(relativeTo: .subheadline) private var initialsSize = 15

  var body: some View {
    Text(name.split(separator: " ").prefix(2).map { String($0.prefix(1)) }.joined().uppercased())
      .font(
        .system(
          size: prominent ? min(initialsSize * 1.3, 30) : min(initialsSize, 22), weight: .semibold)
      )
      .foregroundStyle(.white)
      .frame(
        width: prominent ? min(size * 1.8, 88) : min(size, 52),
        height: prominent ? min(size * 1.8, 88) : min(size, 52)
      )
      .background(RipcordTheme.avatarColors[userId % RipcordTheme.avatarColors.count], in: Circle())
      .accessibilityHidden(true)
  }
}
