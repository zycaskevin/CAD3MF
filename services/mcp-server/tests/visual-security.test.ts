import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  downloadChatGptVisualFile,
  isPrivateNetworkAddress,
} from "../src/visual-file-ingest.js";
import type { VisualProvider } from "../src/visual-provider.js";
import { VisualRuntime } from "../src/visual-runtime.js";
import type {
  ConceptGenerationResult,
  ConceptProviderContext,
  TurnaroundGenerationResult,
  TurnaroundProviderContext,
  VisualAnalysisResult,
  VisualProviderContext,
} from "../src/visual-types.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3QAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

class ByteAssertingProvider implements VisualProvider {
  readonly providerId = "byte-asserting-test";
  readonly modelId = "fixture-png-v1";
  sawAnalyzeBytes = false;
  sawConceptBytes = false;
  sawTurnaroundSourceBytes = false;
  sawTurnaroundConceptBytes = false;

  async analyze(context: VisualProviderContext): Promise<VisualAnalysisResult> {
    this.sawAnalyzeBytes = Boolean(context.sourceAssets[0]?.bytes?.byteLength);
    return {
      observedFeatures: [
        {
          id: "requested-form",
          type: "requested_form",
          value: context.designPrompt,
          confidence: 1,
          evidenceAssetIds: context.sourceAssets.map((asset) => asset.assetId),
          userConfirmed: true,
        },
      ],
      assumptions: [],
      questions: [],
      notes: [],
    };
  }

  async generateConcept(context: ConceptProviderContext): Promise<ConceptGenerationResult> {
    this.sawConceptBytes = Boolean(context.sourceAssets[0]?.bytes?.byteLength);
    return {
      brief: context.designPrompt,
      designNotes: [],
      openDecisions: [
        {
          id: "pose",
          prompt: "Confirm pose",
          required: true,
          status: "open",
        },
      ],
      images: [{ bytes: PNG, mediaType: "image/png", widthPx: 1, heightPx: 1 }],
    };
  }

  async generateTurnaround(
    context: TurnaroundProviderContext,
  ): Promise<TurnaroundGenerationResult> {
    this.sawTurnaroundSourceBytes = Boolean(context.sourceAssets[0]?.bytes?.byteLength);
    this.sawTurnaroundConceptBytes = Boolean(context.conceptImages[0]?.bytes?.byteLength);
    return {
      views: [
        "front",
        "left",
        "right",
        "back",
        "three_quarter_front",
        "three_quarter_back",
      ].map((view) => ({
        view: view as
          | "front"
          | "left"
          | "right"
          | "back"
          | "three_quarter_front"
          | "three_quarter_back",
        bytes: PNG,
        mediaType: "image/png" as const,
        widthPx: 1,
        heightPx: 1,
        projection: "orthographic_like" as const,
      })),
      consistency: {
        pass: true,
        identityScore: 1,
        styleScore: 1,
        silhouetteScore: 1,
        warnings: [],
      },
    };
  }
}

test("visual file ingestion rejects local/private network targets before download", async () => {
  assert.equal(isPrivateNetworkAddress("127.0.0.1"), true);
  assert.equal(isPrivateNetworkAddress("10.1.2.3"), true);
  assert.equal(isPrivateNetworkAddress("172.16.0.1"), true);
  assert.equal(isPrivateNetworkAddress("192.168.1.2"), true);
  assert.equal(isPrivateNetworkAddress("::1"), true);
  assert.equal(isPrivateNetworkAddress("fd00::1"), true);
  assert.equal(isPrivateNetworkAddress("8.8.8.8"), false);
  assert.equal(isPrivateNetworkAddress("2606:4700:4700::1111"), false);

  await assert.rejects(
    downloadChatGptVisualFile({
      downloadUrl: "http://example.com/file.png",
      fileId: "file-http",
      role: "concept",
    }),
    /must use HTTPS/,
  );

  await assert.rejects(
    downloadChatGptVisualFile({
      downloadUrl: "https://127.0.0.1/file.png",
      fileId: "file-loopback",
      role: "concept",
    }),
    /private network address/,
  );
});

test("ingested source and generated concept bytes survive runtime restart for providers", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-visual-bytes-"));
  try {
    const firstProvider = new ByteAssertingProvider();
    const first = new VisualRuntime({ dataDir, provider: firstProvider });
    const analyzed = await first.analyzeVisualInput({
      projectId: "visual-byte-persistence",
      productKind: "figurine",
      designPrompt: "Create a small collectible figure.",
      sourceAssets: [
        {
          assetId: "source-ingested-image",
          sha256: PNG_SHA,
          mediaType: "image/png",
          role: "identity_reference",
          bytes: PNG,
        },
      ],
    });
    assert.equal(firstProvider.sawAnalyzeBytes, true);
    assert.equal(JSON.stringify(analyzed).includes("bytes"), false);

    const secondProvider = new ByteAssertingProvider();
    const second = new VisualRuntime({ dataDir, provider: secondProvider });
    const generated = await second.generateConcept("visual-byte-persistence");
    assert.equal(secondProvider.sawConceptBytes, true);
    const concept = generated.visual_concept as Record<string, unknown>;
    assert.equal(JSON.stringify(concept).includes("bytes"), false);

    const confirmed = second.confirmDesign({
      projectId: "visual-byte-persistence",
      conceptRevisionId: String(concept.revision_id),
      answers: { pose: "standing" },
    });
    const locked = confirmed.visual_concept as Record<string, unknown>;

    const thirdProvider = new ByteAssertingProvider();
    const third = new VisualRuntime({ dataDir, provider: thirdProvider });
    await third.generateTurnaround(
      "visual-byte-persistence",
      String(locked.revision_id),
      "full_six_view",
    );
    assert.equal(thirdProvider.sawTurnaroundSourceBytes, true);
    assert.equal(thirdProvider.sawTurnaroundConceptBytes, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
