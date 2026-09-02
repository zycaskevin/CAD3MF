import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { HostVisualConceptAdopter } from "../src/visual-adoption.js";
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

test("host-provided concept can be adopted, explicitly locked, and reused downstream", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-host-concept-"));
  try {
    const analysisProvider = new ByteAssertingProvider();
    const initial = new VisualRuntime({ dataDir, provider: analysisProvider });
    await initial.analyzeVisualInput({
      projectId: "host-concept-flow",
      productKind: "vehicle",
      designPrompt: "Design a futuristic modular tank with a replaceable upper shell.",
      style: "futuristic_hard_surface",
      sourceAssets: [
        {
          assetId: "tank-reference",
          sha256: PNG_SHA,
          mediaType: "image/png",
          role: "concept",
          bytes: PNG,
        },
      ],
    });

    const adopter = new HostVisualConceptAdopter({ dataDir });
    const adopted = adopter.adoptConcept({
      projectId: "host-concept-flow",
      brief: "User-selected futuristic modular tank concept generated in the ChatGPT host.",
      designNotes: ["Preserve the low hull and detachable upper module."],
      conceptImages: [
        {
          assetId: "host-selected-concept",
          sha256: PNG_SHA,
          mediaType: "image/png",
          role: "concept",
          bytes: PNG,
        },
      ],
    });
    const concept = adopted.visual_concept as Record<string, unknown>;
    assert.equal(concept.status, "needs_confirmation");
    const provenance = concept.provenance as Record<string, unknown>;
    assert.equal(provenance.provider, "host-provided");
    assert.equal(provenance.model, "unattested-host-visual");
    assert.equal(JSON.stringify(concept).includes("bytes"), false);

    const lockRuntime = new VisualRuntime({ dataDir, provider: new ByteAssertingProvider() });
    const confirmed = lockRuntime.confirmDesign({
      projectId: "host-concept-flow",
      conceptRevisionId: String(concept.revision_id),
      notes: ["Explicitly approved by the user."],
    });
    const locked = confirmed.visual_concept as Record<string, unknown>;
    assert.equal(locked.status, "design_locked");

    const turnaroundProvider = new ByteAssertingProvider();
    const downstream = new VisualRuntime({ dataDir, provider: turnaroundProvider });
    await downstream.generateTurnaround(
      "host-concept-flow",
      String(locked.revision_id),
      "full_six_view",
    );
    assert.equal(turnaroundProvider.sawTurnaroundSourceBytes, true);
    assert.equal(turnaroundProvider.sawTurnaroundConceptBytes, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
