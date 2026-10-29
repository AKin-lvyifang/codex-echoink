import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { saveClipboardImageAttachment } from "../../core/clipboard-images";
import { preparePluginDataRoot } from "../../plugin/plugin-data-paths";
import {
  PiImageInputError,
  detectPiImageMimeType,
  preparePiChatImage,
  preparePiChatImages
} from "../../ui/codex-view/pi-image-input";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/FuiiivrDnP/2Q==",
  "base64"
);
const GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64"
);
const WEBP_1X1 = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
  "base64"
);

export async function runPiImageInputTests(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-pi-image-"));
  const dataRoot = await preparePluginDataRoot(root, { id: "echoink-test" }, "custom-config");
  try {
    await directFormatsStayOrderedAndUseContentDetection(root);
    await clipboardImagesKeepInternalPathsOutOfDisplayMetadata(root);
    await publicConversionAndResizeProducePiContent(root);
    await unconvertibleAndOrdinaryFilesFailBeforePayload(root);
  } finally {
    dataRoot.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

async function clipboardImagesKeepInternalPathsOutOfDisplayMetadata(
  root: string
): Promise<void> {
  const attachment = await saveClipboardImageAttachment(
    new File([PNG_1X1], "image.png", { type: "image/png" }),
    {
      vaultPath: root,
      pluginDir: "echoink-test",
      timestamp: 1_720_000_000_000,
      index: 1
    }
  );
  assert.equal(path.dirname(attachment.path), path.join(root, "custom-config", "plugins", "echoink-test", "clipboard"));
  assert.equal(attachment.name, "粘贴图片 2.png");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.availability, "available");
  assert.match(path.basename(attachment.path), /^clipboard-1720000000000-1\.png$/u);
  assert.doesNotMatch(attachment.name, /clipboard-/u);
}

async function directFormatsStayOrderedAndUseContentDetection(
  root: string
): Promise<void> {
  const fixtures = [
    ["one.png", PNG_1X1, "image/png"],
    ["two.jpg", JPEG_1X1, "image/jpeg"],
    ["three.gif", GIF_1X1, "image/gif"],
    ["four.webp", WEBP_1X1, "image/webp"]
  ] as const;
  for (const [name, bytes] of fixtures) {
    await writeFile(path.join(root, name), bytes);
  }
  const prepared = await preparePiChatImages(fixtures.map(
    ([name, _bytes, mimeType], index) => ({
      type: "image" as const,
      name,
      path: path.join(root, name),
      ...(index === 0 ? { mimeType: "image/jpeg" } : { mimeType })
    })
  ));
  assert.deepEqual(
    prepared.map((image) => image.attachment.name),
    fixtures.map(([name]) => name)
  );
  assert.deepEqual(
    prepared.map((image) => image.content.mimeType),
    fixtures.map(([, , mimeType]) => mimeType)
  );
  assert.deepEqual(
    prepared.map((image) => image.attachment.availability),
    fixtures.map(() => "available")
  );
  assert.equal(prepared[0]?.attachment.mimeType, "image/png");
  assert.equal(detectPiImageMimeType(PNG_1X1, "image/jpeg"), "image/png");
}

async function publicConversionAndResizeProducePiContent(
  root: string
): Promise<void> {
  const bmpPath = path.join(root, "convert.bmp");
  await writeFile(bmpPath, bmp(1, 1));
  const converted = await preparePiChatImage({
    type: "image",
    name: "convert.bmp",
    path: bmpPath
  });
  assert.equal(converted.attachment.mimeType, "image/bmp");
  assert.equal(converted.content.mimeType, "image/png");

  const pasted = await preparePiChatImage({
    type: "image",
    name: "clipboard-1720000000000-0.png",
    path: path.join(root, "one.png")
  }, 1);
  assert.equal(pasted.attachment.name, "粘贴图片 2.png");
  assert.doesNotMatch(pasted.attachment.name, /clipboard-/u);

  const oversizedPath = path.join(root, "oversized.bmp");
  await writeFile(oversizedPath, bmp(2_501, 1));
  const oversized = await preparePiChatImage({
    type: "image",
    name: "oversized.bmp",
    path: oversizedPath
  });
  const output = await resizeImage(
    Buffer.from(oversized.content.data, "base64"),
    oversized.content.mimeType
  );
  assert.ok(output, "Pi must decode the prepared oversized image");
  assert.ok(output.originalWidth <= 2_000);
  assert.equal(output.wasResized, false, "the preparation module must resize first");
}

async function unconvertibleAndOrdinaryFilesFailBeforePayload(
  root: string
): Promise<void> {
  const fakeHeic = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63,
    0x00, 0x00, 0x00, 0x00,
    0x68, 0x65, 0x69, 0x63,
    0x00, 0x00, 0x00, 0x00
  ]);
  const heicPath = path.join(root, "broken.heic");
  await writeFile(heicPath, fakeHeic);
  await assert.rejects(
    preparePiChatImage({
      type: "image",
      name: "broken.heic",
      path: heicPath
    }),
    (error: unknown) => error instanceof PiImageInputError
      && error.code === "image_conversion_failed"
      && /本轮没有发送/u.test(error.message)
  );
  await assert.rejects(
    preparePiChatImage({
      type: "image",
      name: "clipboard-1720000000000-0.png",
      path: path.join(root, "missing.png")
    }),
    (error: unknown) => error instanceof PiImageInputError
      && error.code === "image_unreadable"
      && /粘贴图片 1\.png/u.test(error.message)
      && !/clipboard-/u.test(error.message)
  );
  const fakeHeif = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x6d, 0x69, 0x66, 0x31,
    0x00, 0x00, 0x00, 0x00,
    0x6d, 0x69, 0x66, 0x31,
    0x00, 0x00, 0x00, 0x00
  ]);
  assert.equal(
    detectPiImageMimeType(fakeHeif, "application/octet-stream"),
    "image/heif"
  );
  const heifPath = path.join(root, "camera-upload");
  await writeFile(heifPath, fakeHeif);
  await assert.rejects(
    preparePiChatImage({
      type: "image",
      name: "camera-upload",
      path: heifPath,
      mimeType: "image/heif"
    }),
    (error: unknown) => error instanceof PiImageInputError
      && error.code === "image_conversion_failed"
      && /本轮没有发送/u.test(error.message)
  );
  const disguisedPath = path.join(root, "not-an-image.png");
  await writeFile(disguisedPath, "plain text is not image content", "utf8");
  await assert.rejects(
    preparePiChatImage({
      type: "image",
      name: "not-an-image.png",
      path: disguisedPath
    }),
    (error: unknown) => error instanceof PiImageInputError
      && error.code === "image_format_unsupported"
  );
  const damagedPngPath = path.join(root, "damaged.png");
  await writeFile(damagedPngPath, PNG_1X1.subarray(0, 12));
  await assert.rejects(
    preparePiChatImage({
      type: "image",
      name: "damaged.png",
      path: damagedPngPath
    }),
    (error: unknown) => error instanceof PiImageInputError
      && error.code === "image_resize_failed"
      && /图片可能已损坏或无法缩放/u.test(error.message)
  );
  await assert.rejects(
    preparePiChatImages([{
      type: "file",
      name: "note.md",
      path: path.join(root, "note.md")
    }]),
    (error: unknown) => error instanceof PiImageInputError
      && error.code === "ordinary_file_unsupported"
  );
}

function bmp(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const bytes = Buffer.alloc(54 + pixelBytes);
  bytes.write("BM", 0);
  bytes.writeUInt32LE(bytes.byteLength, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(pixelBytes, 34);
  for (let offset = 54; offset < bytes.byteLength; offset += 3) {
    bytes[offset] = 0x22;
    if (offset + 1 < bytes.byteLength) bytes[offset + 1] = 0x66;
    if (offset + 2 < bytes.byteLength) bytes[offset + 2] = 0xaa;
  }
  return bytes;
}
