import {
  isExternalBrowserProtocol,
  isTrustedRendererUrl,
  type TRendererTrustOptions,
} from "./renderer-trust";

type TNavigationPolicyOptions = TRendererTrustOptions;

type TNavigationPolicyResult =
  | {
      action: "allow";
      openExternal: false;
    }
  | {
      action: "deny";
      openExternal: boolean;
    };

const classifyMainFrameNavigationUrl = (
  navigationUrl: string,
  options: TNavigationPolicyOptions,
): TNavigationPolicyResult => {
  try {
    const parsedNavigationUrl = new URL(navigationUrl);

    if (isTrustedRendererUrl(navigationUrl, options)) {
      return {
        action: "allow",
        openExternal: false,
      };
    }

    return {
      action: "deny",
      openExternal: isExternalBrowserProtocol(parsedNavigationUrl.protocol),
    };
  } catch {
    return {
      action: "deny",
      openExternal: false,
    };
  }
};

export type { TNavigationPolicyOptions, TNavigationPolicyResult };
export { classifyMainFrameNavigationUrl };
