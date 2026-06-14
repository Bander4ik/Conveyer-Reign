import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getDriveClient, ensureTopLevelFolders } from "@/lib/services/gdrive";

/**
 * GET /api/library/runs — lists the runs saved to Google Drive's Clips Library.
 *
 * Drive layout (written by run-upload.ts):
 *   Conveyer/Clips Library/{runFolder}/clips.json   ← manifest we read here
 *
 * Always returns JSON (even on failure) with an `error` field — the Library
 * page reads `r.error` and never has to deal with an HTML error page.
 */

interface ManifestClip {
  index: number;
  file: string;
  drive_file_id: string;
  scene_text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  audio_duration_sec: number | null;
}
interface Manifest {
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
  clips?: ManifestClip[];
}

export async function GET() {
  ensureInit();
  try {
    const drive = getDriveClient();
    if (!drive) {
      return NextResponse.json({ error: "Google Drive is not connected. Connect it in Settings." });
    }

    const { clipsLibraryId } = await ensureTopLevelFolders();

    // Per-run sub-folders inside the Clips Library, newest first.
    const folderList = await drive.files.list({
      q: `'${clipsLibraryId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id,name,createdTime)",
      orderBy: "createdTime desc",
      pageSize: 200,
    });
    const folders = folderList.data.files ?? [];

    const runs = [];
    for (const f of folders) {
      if (!f.id) continue;

      // Each real run folder has a clips.json manifest; skip folders without one.
      const manifestList = await drive.files.list({
        q: `'${f.id}' in parents and name='clips.json' and trashed=false`,
        fields: "files(id)",
        pageSize: 1,
      });
      const manifestFileId = manifestList.data.files?.[0]?.id;
      if (!manifestFileId) continue;

      let manifest: Manifest;
      try {
        const content = await drive.files.get(
          { fileId: manifestFileId, alt: "media" },
          { responseType: "text" }
        );
        manifest = JSON.parse(content.data as unknown as string) as Manifest;
      } catch {
        // Unreadable / malformed manifest — skip this run rather than fail the page.
        continue;
      }

      const clips = (manifest.clips ?? []).map((c) => ({
        index: c.index,
        file: c.file,
        drive_file_id: c.drive_file_id,
        drive_file_link: `https://drive.google.com/file/d/${c.drive_file_id}/view`,
        scene_text: c.scene_text,
        visual_prompt: c.visual_prompt,
        duration_hint_sec: c.duration_hint_sec,
        audio_duration_sec: c.audio_duration_sec ?? null,
      }));

      runs.push({
        drive_folder_id: f.id,
        drive_folder_name: f.name ?? manifest.folder_name ?? "(run)",
        drive_folder_link: `https://drive.google.com/drive/folders/${f.id}`,
        run_id: manifest.run_id ?? "",
        run_title: manifest.run_title ?? null,
        folder_name: manifest.folder_name ?? f.name ?? "",
        created_at: manifest.created_at ?? f.createdTime ?? "",
        scene_count: manifest.scene_count ?? clips.length,
        uploaded_clip_count: clips.length,
        settings: {
          animation_provider: manifest.settings_snapshot?.animation_provider ?? "",
          animation_model: manifest.settings_snapshot?.animation_model ?? "",
          video_resolution: manifest.settings_snapshot?.video_resolution ?? "",
        },
        clips,
      });
    }

    return NextResponse.json({ runs });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Failed to load the Drive library" });
  }
}
