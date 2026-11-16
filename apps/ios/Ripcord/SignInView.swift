import SwiftUI

struct SignInView: View {
  struct Presentation {
    var needsServerPassword = false
  }

  @ObservedObject var session: Session
  @Binding var presentation: Presentation
  @FocusState private var loginFocus: LoginField?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private enum LoginField: Hashable {
    case server, identity, password, serverPassword, verification
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        let brandingLayout =
          dynamicTypeSize.isAccessibilitySize
          ? AnyLayout(HStackLayout(spacing: 16))
          : AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
        brandingLayout {
          Image("RipcordLogo").resizable().scaledToFit()
            .frame(width: dynamicTypeSize.isAccessibilitySize ? 48 : 76, height: 60)
            .accessibilityHidden(true)
          Text("Ripcord").font(
            dynamicTypeSize.isAccessibilitySize ? .title2.bold() : .largeTitle.bold()
          ).tracking(-1)
          if !dynamicTypeSize.isAccessibilitySize {
            Text("Your people. Your server.").font(.title3.weight(.medium))
            Text("Sign in to catch up, join voice, or watch a screen.")
              .font(.subheadline).foregroundStyle(RipcordTheme.muted)
          }
        }.padding(.top, 16)
        VStack(alignment: .leading, spacing: 18) {
          loginField("Server URL") {
            TextField(
              "Server URL", text: $session.serverAddress,
              prompt: Text("https://your-server.example").foregroundColor(RipcordTheme.muted)
            )
            .textContentType(.URL).keyboardType(.URL).autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .focused($loginFocus, equals: .server).submitLabel(.next)
            .onSubmit { loginFocus = .identity }
            .accessibilityIdentifier("serverURL")
          }
          loginField("Username or email") {
            TextField(
              "Username or email", text: $session.identity,
              prompt: Text("Username or email").foregroundColor(RipcordTheme.muted)
            )
            .textContentType(.username).autocorrectionDisabled().textInputAutocapitalization(
              .never
            )
            .focused($loginFocus, equals: .identity).submitLabel(.next)
            .onSubmit { loginFocus = .password }
            .accessibilityIdentifier("identity")
          }
          loginField("Password") {
            SecureField(
              "Password", text: $session.password,
              prompt: Text("Password").foregroundColor(RipcordTheme.muted)
            ).textContentType(.password)
              .focused($loginFocus, equals: .password)
              .submitLabel(presentation.needsServerPassword ? .next : .go)
              .onSubmit {
                if presentation.needsServerPassword {
                  loginFocus = .serverPassword
                } else {
                  submitSignIn()
                }
              }
              .accessibilityIdentifier("password")
          }
          DisclosureGroup(isExpanded: $presentation.needsServerPassword) {
            loginField("Server password") {
              SecureField(
                "Server password", text: $session.serverPassword,
                prompt: Text("Server password").foregroundColor(RipcordTheme.muted)
              )
              .focused($loginFocus, equals: .serverPassword).submitLabel(.go)
              .onSubmit { submitSignIn() }
              .accessibilityIdentifier("serverPassword")
            }.padding(.top, 12)
          } label: {
            Text("This server needs a password").multilineTextAlignment(.leading)
          }
          .font(.callout).foregroundStyle(RipcordTheme.muted)
          if session.challengeToken != nil {
            loginField("Two-factor authentication") {
              TextField("Verification code", text: $session.verificationCode).textContentType(
                .oneTimeCode
              )
              .focused($loginFocus, equals: .verification)
              .keyboardType(.numberPad).accessibilityIdentifier("verificationCode")
            }
          }
          if session.challengeToken != nil || session.authenticated {
            Button("Start sign-in again") { session.restartSignIn() }
              .accessibilityIdentifier("restartSignIn")
          }
          if let error = session.errorMessage {
            Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(
              RipcordTheme.danger)
          }
          Button(action: submitSignIn) {
            HStack {
              Spacer()
              Text(
                session.authenticated
                  ? "Retry server join"
                  : (session.challengeToken == nil ? "Connect" : "Verify and connect")
              ).bold()
              Spacer()
              if session.busy { ProgressView() }
            }
            .frame(minHeight: 28)
          }
          .buttonStyle(.borderedProminent).buttonBorderShape(.roundedRectangle)
          .foregroundStyle(
            session.identity.isEmpty
              || (session.password.isEmpty && session.challengeToken == nil
                && !session.authenticated)
              ? RipcordTheme.muted : RipcordTheme.onAccent
          )
          .disabled(
            session.busy || session.identity.isEmpty
              || (session.password.isEmpty && session.challengeToken == nil
                && !session.authenticated)
          )
          .accessibilityIdentifier("connect")
        }
        Text(
          "Native iOS preview. Your credentials stay in memory and are cleared when you sign out."
        )
        .font(.caption).foregroundStyle(RipcordTheme.muted)
      }
      .padding(24).frame(maxWidth: 480)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(RipcordTheme.sidebar)
  }

  private func submitSignIn() {
    guard !session.busy, !session.identity.isEmpty,
      !session.password.isEmpty || session.challengeToken != nil || session.authenticated
    else { return }
    loginFocus = nil
    Task { await session.signIn() }
  }

  private func loginField<Field: View>(_ title: String, @ViewBuilder field: () -> Field)
    -> some View
  {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.caption.weight(.semibold)).foregroundStyle(RipcordTheme.muted)
      field().font(.body).padding(14)
        .background(RipcordTheme.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(RipcordTheme.border))
    }
  }
}

private struct SignInPreview: View {
  @StateObject private var session = Session()
  @State private var presentation = SignInView.Presentation()

  var body: some View {
    SignInView(session: session, presentation: $presentation)
      .tint(RipcordTheme.accent)
      .foregroundStyle(RipcordTheme.text)
  }
}

#Preview("Sign in · Light") {
  SignInPreview().preferredColorScheme(.light)
}

#Preview("Sign in · Dark · Accessibility") {
  SignInPreview().preferredColorScheme(.dark).dynamicTypeSize(.accessibility3)
}
