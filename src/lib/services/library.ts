import { getSetting } from "../settings";
import { ensureTopLevelFolders, getDriveClient } from "./gdrive";
import type { Scene } from "./scene-split";

/**
 * Library service: lists past runs uploaded to Drive, and searches them for
 * clips relevant to a new set of scenes.
 *
 * Data source is `clips.json` files inside each per-run sub-folder in
 * `Clips Library/`. The manifest is what run-upload.ts writes after every run.
 */

export interface LibraryRunSummary {
  drive_folder_id: string;
  drive_folder_name: string;
  drive_folder_link: string;
  run_id: string;
  run_title: string | null;
  folder_name: string;
  created_at: string;
  scene_count: number;
  uploaded_clip_count: number;
  settings: {
    animation_provider: string;
    animation_model: string;
    video_resolution: string;
  };
  clips: LibraryClip[];
}

export interface LibraryClip {
  index: number;
  file: string;
  drive_file_id: string;
  drive_file_link: string;
  scene_text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  audio_duration_sec: number | null;
}

interface RawManifest {
  run_id?: string;
  run_title?: string | null;
  folder_name?: string;
  created_at?: string;
  scene_count?: number;
  settings_snapshot?: {
    animation_provider?: string;
    animation_model?: string;
    video_resolution?: string;
  };
  clips?: Array<{
    index?: number;
    file?: string;
    drive_file_id?: string;
    scene_text?: string;
    visual_prompt?: string;
    duration_hint_sec?: number;
    audio_duration_sec?: number | null;
  }>;
}

/** Lists every run in the user's Drive Clips Library, newest first. */
export async function listLibraryRuns(): Promise<LibraryRunSummary[]> {
  const drive = getDriveClient();
  if (!drive) return [];

  const { clipsLibraryId } = await ensureTopLevelFolders();

  // List all per-run sub-folders inside Clips Library
  const folders = await drive.files.list({
    q: `'${clipsLibraryId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name, createdTime)",
    pageSize: 500,
    orderBy: "createdTime desc",
  });

  const items = await Promise.all(
    (folders.data.files ?? []).map(async (folder): Promise<LibraryRunSummary | null> => {
      if (!folder.id || !folder.name) return null;
      try {
        // Find clips.json inside this run's folder
        const found = await drive.files.list({
          q: `'${folder.id}' in parents and name='clips.json' and trashed=false`,
          fields: "files(id)",
          pageSize: 1,
        });
        const clipsJsonId = found.data.files?.[0]?.id;
        if (!clipsJsonId) return null;

        // Download clips.json content
        const res = await drive.files.get(
          { fileId: clipsJsonId, alt: "media" },
          { responseType: "text" }
        );
        // `data` may already be parsed (axios sometimes does that) or a raw string
        let manifest: RawManifest;
        if (typeof res.data === "string") {
          try {
            manifest = JSON.parse(res.data) as RawManifest;
          } catch {
            return null;
          }
        } else {
          manifest = res.data as RawManifest;
        }

        const clips: LibraryClip[] = (manifest.clips ?? []).map((c) => ({
          index: Number(c.index ?? 0),
          file: String(c.file ?? ""),
          drive_file_id: String(c.drive_file_id ?? ""),
          drive_file_link: c.drive_file_id
            ? `https://drive.google.com/file/d/${c.drive_file_id}/view`
            : "",
          scene_text: String(c.scene_text ?? ""),
          visual_prompt: String(c.visual_prompt ?? ""),
          duration_hint_sec: Number(c.duration_hint_sec ?? 0),
          audio_duration_sec: c.audio_duration_sec ?? null,
        }));

        return {
          drive_folder_id: folder.id,
          drive_folder_name: folder.name,
          drive_folder_link: `https://drive.google.com/drive/folders/${folder.id}`,
          run_id: String(manifest.run_id ?? ""),
          run_title: manifest.run_title ?? null,
          folder_name: String(manifest.folder_name ?? folder.name),
          created_at: String(manifest.created_at ?? folder.createdTime ?? ""),
          scene_count: Number(manifest.scene_count ?? clips.length),
          uploaded_clip_count: clips.length,
          settings: {
            animation_provider: String(manifest.settings_snapshot?.animation_provider ?? ""),
            animation_model: String(manifest.settings_snapshot?.animation_model ?? ""),
            video_resolution: String(manifest.settings_snapshot?.video_resolution ?? ""),
          },
          clips,
        };
      } catch {
        return null;
      }
    })
  );

  return items.filter((x): x is LibraryRunSummary => x !== null);
}

export interface ClipMatch {
  /** Index of the NEW scene this match is for. */
  new_scene_index: number;
  /** Drive file ID of the library clip. */
  drive_file_id: string;
  /** 0-100, higher = better fit. */
  score: number;
  /** Short reason from the LLM. */
  reason: string;
  /** Snapshot of source clip metadata, for UI preview. */
  source: {
    run_title: string | null;
    folder_name: string;
    drive_file_link: string;
    scene_text: string;
    visual_prompt: string;
    audio_duration_sec: number | null;
  };
}

/**
 * Ask Gemini to rank library clips against the new scenes we're about to
 * generate. Returns up to N matches per scene with score >= minScore.
 *
 * If the library is empty, returns []. If GOOGLE_API_KEY is missing, throws.
 */
export async function findSimilarClips(
  newScenes: Scene[],
  options: { minScore?: number; topPerScene?: number } = {}
): Promise<ClipMatch[]> {
  const minScore = options.minScore ?? 60;
  const topPerScene = options.topPerScene ?? 3;

  const runs = await listLibraryRuns();
  if (runs.length === 0) return [];

  // Build a flat list of every clip in the library, with metadata + source.
  const allClips: Array<{ clip: LibraryClip; source: LibraryRunSummary }> = [];
  for (const r of runs) for (const c of r.clips) allClips.push({ clip: c, source: r });
  if (allClips.length === 0) return [];

  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set — needed for AI matching");

  const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";

  const systemPrompt = `You are matching scene clips from a video library to NEW scenes in a video we're about to generate. For each new scene, find the most visually and tonally similar clips from the library that could be reused instead of generating from scratch.

SCORING — total 100 points:
- Visual subject match (40 pts): same kind of thing/place/person on screen
- Mood and atmosphere (25 pts): lighting, color palette, tone
- Motion / animation style (15 pts): motion energy fits the new scene
- Duration fit (15 pts): clip duration >= new scene needs (trimming is fine, stretching is not)
- Format match (5 pts): aspect ratio / resolution

OUTPUT — return JSON only, no prose:
{
  "matches": [
    {"new_scene_index": 1, "drive_file_id": "...", "score": 87, "reason": "Brief reason in one sentence."}
  ]
}

Rules:
- Only include matches with score >= ${minScore}
- At most ${topPerScene} matches per new_scene_index, sorted by score desc
- If no library clip is a good fit for a new scene, don't include any match for that scene
- Output strictly valid JSON, no markdown fences`;

  const userPayload = {
    new_scenes: newScenes.map((s) => ({
      index: s.index,
      scene_text: s.text,
      visual_prompt: s.visual_prompt,
      duration_hint_sec: s.duration_hint_sec,
    })),
    library: allClips.map(({ clip, source }) => ({
      drive_file_id: clip.drive_file_id,
      source_run: source.run_title || source.folder_name,
      scene_text: clip.scene_text,
      visual_prompt: clip.visual_prompt,
      duration_hint_sec: clip.duration_hint_sec,
      audio_duration_sec: clip.audio_duration_sec,
      animation_model: source.settings.animation_model,
      video_resolution: source.settings.video_resolution,
    })),
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(userPayload) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      maxOutputTokens: 20000,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!resp.ok) {
    const err = (await resp.text()).slice(0, 400);
    throw new Error(`Gemini ${resp.status}: ${err}`);
  }
  const json = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  const text =
    json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) return [];

  let parsed: { matches?: Array<{ new_scene_index?: number; drive_file_id?: string; score?: number; reason?: string }> };
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    // Try to extract a JSON object even if the model wrapped in markdown
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }

  const clipById = new Map(allClips.map(({ clip, source }) => [clip.drive_file_id, { clip, source }]));
  const matches: ClipMatch[] = [];

  for (const m of parsed.matches ?? []) {
    if (!m.drive_file_id || m.new_scene_index === undefined) continue;
    const score = Number(m.score ?? 0);
    if (score < minScore) continue;
    const entry = clipById.get(m.drive_file_id);
    if (!entry) continue;
    matches.push({
      new_scene_index: Number(m.new_scene_index),
      drive_file_id: m.drive_file_id,
      score,
      reason: String(m.reason ?? ""),
      source: {
        run_title: entry.source.run_title,
        folder_name: entry.source.folder_name,
        drive_file_link: entry.clip.drive_file_link,
        scene_text: entry.clip.scene_text,
        visual_prompt: entry.clip.visual_prompt,
        audio_duration_sec: entry.clip.audio_duration_sec,
      },
    });
  }

  // Cap top-K per scene client-side too (defense against LLM over-returning)
  const byScene = new Map<number, ClipMatch[]>();
  for (const m of matches) {
    const list = byScene.get(m.new_scene_index) ?? [];
    list.push(m);
    byScene.set(m.new_scene_index, list);
  }
  const capped: ClipMatch[] = [];
  for (const [, list] of byScene) {
    list.sort((a, b) => b.score - a.score);
    capped.push(...list.slice(0, topPerScene));
  }
  return capped;
}
