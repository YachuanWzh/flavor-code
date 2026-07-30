import { describe, expect, it } from "vitest";

import {
  cloneModelContent,
  modelContentText,
  modelContentTranscriptText,
  type ModelContent,
} from "../../src/models/types.js";

describe("multimodal model content", () => {
  const content: ModelContent = [
    { type: "text", text: "What is wrong with this UI?" },
    {
      type: "image",
      source: { type: "file", path: "C:\\work\\.flavor\\session-assets\\s1\\a.png" },
      mediaType: "image/png",
      sha256: "a".repeat(64),
      bytes: 128,
      name: "screen.png",
    },
  ];

  it("keeps images out of text-only routing while exposing transcript references", () => {
    expect(modelContentText(content)).toBe("What is wrong with this UI?");
    expect(modelContentTranscriptText(content)).toBe("What is wrong with this UI?\n[Image #1]");
  });

  it("deep-clones block arrays and nested image sources", () => {
    const cloned = cloneModelContent(content);
    expect(cloned).toEqual(content);
    expect(cloned).not.toBe(content);
    expect(Array.isArray(cloned) && cloned[1]).not.toBe(content[1]);
    if (Array.isArray(cloned) && cloned[1]?.type === "image") {
      expect(cloned[1].source).not.toBe(Array.isArray(content) && content[1]?.type === "image"
        ? content[1].source
        : undefined);
    }
  });

  it("preserves legacy string content", () => {
    expect(modelContentText("hello")).toBe("hello");
    expect(modelContentTranscriptText("hello")).toBe("hello");
    expect(cloneModelContent("hello")).toBe("hello");
  });
});
