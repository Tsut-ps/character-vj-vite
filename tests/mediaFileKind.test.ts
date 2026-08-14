import assert from "node:assert/strict";
import test from "node:test";
import { detectMediaFileKind } from "../src/app/media/mediaFileKind.ts";

// ブラウザが返すMIMEから素材種別を判定できることを確認する
test("MIMEから画像と音声を判定する", () => {
  assert.equal(detectMediaFileKind({ name: "asset.bin", type: "image/png" }), "image");
  assert.equal(detectMediaFileKind({ name: "asset.bin", type: "audio/mpeg" }), "audio");
});

// WindowsでMIMEが空でも一般的な拡張子を受け付けることを確認する
test("MIMEがない素材を拡張子から判定する", () => {
  assert.equal(detectMediaFileKind({ name: "character.WEBP", type: "" }), "image");
  assert.equal(detectMediaFileKind({ name: "effect.MP3", type: "" }), "audio");
  assert.equal(detectMediaFileKind({ name: "document.txt", type: "" }), null);
});
