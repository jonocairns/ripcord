import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { classifyMainFrameNavigationUrl } from "../navigation-policy";

const packagedIndexPath = path.resolve(
  "/tmp/ripcord/resources/app.asar/renderer-dist/index.html",
);

void describe("classifyMainFrameNavigationUrl", () => {
  void it("allows the packaged renderer index file", () => {
    const result = classifyMainFrameNavigationUrl(
      pathToFileURL(packagedIndexPath).toString(),
      {
        packagedIndexPath,
      },
    );

    assert.equal(result.action, "allow");
    assert.equal(result.openExternal, false);
  });

  void it("allows packaged renderer index file hash navigations", () => {
    const result = classifyMainFrameNavigationUrl(
      `${pathToFileURL(packagedIndexPath).toString()}#settings`,
      {
        packagedIndexPath,
      },
    );

    assert.equal(result.action, "allow");
    assert.equal(result.openExternal, false);
  });

  void it("denies other packaged file urls without externalizing", () => {
    const result = classifyMainFrameNavigationUrl(
      pathToFileURL(
        path.resolve(
          "/tmp/ripcord/resources/app.asar/renderer-dist/other.html",
        ),
      ).toString(),
      {
        packagedIndexPath,
      },
    );

    assert.equal(result.action, "deny");
    assert.equal(result.openExternal, false);
  });

  void it("allows same-origin dev renderer navigations", () => {
    const result = classifyMainFrameNavigationUrl(
      "http://localhost:5173/debug?panel=voice",
      {
        packagedIndexPath,
        rendererUrl: "http://localhost:5173",
      },
    );

    assert.equal(result.action, "allow");
    assert.equal(result.openExternal, false);
  });

  void it("denies lookalike dev origins", () => {
    const result = classifyMainFrameNavigationUrl(
      "http://localhost.evil.example:5173",
      {
        packagedIndexPath,
        rendererUrl: "http://localhost:5173",
      },
    );

    assert.equal(result.action, "deny");
    assert.equal(result.openExternal, true);
  });

  void it("denies http and https urls as external browser candidates", () => {
    const httpResult = classifyMainFrameNavigationUrl("http://example.com", {
      packagedIndexPath,
    });
    const httpsResult = classifyMainFrameNavigationUrl("https://example.com", {
      packagedIndexPath,
    });

    assert.equal(httpResult.action, "deny");
    assert.equal(httpResult.openExternal, true);
    assert.equal(httpsResult.action, "deny");
    assert.equal(httpsResult.openExternal, true);
  });

  void it("denies unsafe and malformed urls without externalizing", () => {
    const javascriptResult = classifyMainFrameNavigationUrl(
      "javascript:alert(1)",
      {
        packagedIndexPath,
      },
    );
    const malformedResult = classifyMainFrameNavigationUrl("not a url", {
      packagedIndexPath,
    });

    assert.equal(javascriptResult.action, "deny");
    assert.equal(javascriptResult.openExternal, false);
    assert.equal(malformedResult.action, "deny");
    assert.equal(malformedResult.openExternal, false);
  });
});
