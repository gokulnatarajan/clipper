"use client";

import { useState, useRef, useCallback, useEffect } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

type Tab = "url" | "file";

interface Clip {
  filename: string;
  start: number;
  score: number;
  url: string;
}

interface Job {
  status: string;
  progress: number;
  clips: Clip[];
  error: string | null;
  message?: string;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  uploading: "Uploading",
  downloading: "Downloading VOD",
  analyzing: "Analyzing audio",
  extracting: "Cutting clips",
  done: "Done",
  error: "Error",
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ClipCard({ clip }: { clip: Clip }) {
  const streamUrl = `${API_URL}${clip.url}`;
  const downloadUrl = `${API_URL}${clip.url}?download=true`;

  const handleDownload = useCallback(async () => {
    const res = await fetch(downloadUrl);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = clip.filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [downloadUrl, clip.filename]);

  return (
    <div className="bg-gray-900 rounded-xl overflow-hidden border border-gray-800 flex flex-col">
      <video
        src={streamUrl}
        controls
        preload="metadata"
        className="w-full bg-black"
        style={{ aspectRatio: "9/16" }}
      />
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-400">@{formatTime(clip.start)}</span>
          <span className="text-purple-400 font-semibold">
            {Math.round(clip.score * 100)}%
          </span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-1">
          <div
            className="bg-purple-500 h-1 rounded-full transition-all"
            style={{ width: `${clip.score * 100}%` }}
          />
        </div>
        <button
          onClick={handleDownload}
          className="w-full py-1.5 bg-purple-600 hover:bg-purple-700 active:bg-purple-800 rounded-lg text-xs font-semibold transition-colors"
        >
          Download
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [clipLength, setClipLength] = useState(30);
  const [topN, setTopN] = useState(10);
  const [vertical, setVertical] = useState(true);
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const pollJob = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`${API_URL}/api/job/${id}`);
        if (!res.ok) throw new Error("Job not found");
        const data: Job = await res.json();
        setJob(data);
        if (data.status !== "done" && data.status !== "error") {
          pollRef.current = setTimeout(() => pollJob(id), 1500);
        } else {
          setLoading(false);
        }
      } catch {
        setSubmitError("Lost connection to server.");
        setLoading(false);
      }
    },
    []
  );

  const handleSubmit = async () => {
    if (tab === "url" && !url.trim()) return;
    if (tab === "file" && !file) return;

    stopPolling();
    setLoading(true);
    setSubmitError(null);
    setJob(null);

    try {
      let res: Response;

      if (tab === "url") {
        res = await fetch(`${API_URL}/api/process-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim(), clip_length: clipLength, top_n: topN, vertical }),
        });
      } else {
        const fd = new FormData();
        fd.append("file", file!);
        fd.append("clip_length", String(clipLength));
        fd.append("top_n", String(topN));
        fd.append("vertical", String(vertical));
        res = await fetch(`${API_URL}/api/process-file`, { method: "POST", body: fd });
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { detail?: string }).detail ?? "Server error");
      }

      const { job_id } = (await res.json()) as { job_id: string };
      pollJob(job_id);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to submit");
      setLoading(false);
    }
  };

  const canSubmit = !loading && (tab === "url" ? url.trim().length > 0 : file !== null);
  const isDone = job?.status === "done";
  const isError = job?.status === "error";

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-5xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-5xl font-bold tracking-tight mb-2">
            <span className="text-purple-400">✂</span> Clipper
          </h1>
          <p className="text-gray-400 text-lg">
            Auto-clip Twitch &amp; Kick VODs into TikTok-ready highlights
          </p>
        </div>

        {/* Input card */}
        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 mb-6">
          {/* Tabs */}
          <div className="flex gap-1 bg-gray-800 p-1 rounded-lg w-fit mb-6">
            {(["url", "file"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                disabled={loading}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  tab === t
                    ? "bg-purple-600 text-white"
                    : "text-gray-400 hover:text-white disabled:opacity-50"
                }`}
              >
                {t === "url" ? "Paste URL" : "Upload File"}
              </button>
            ))}
          </div>

          {/* URL input */}
          {tab === "url" && (
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canSubmit && handleSubmit()}
              placeholder="https://www.twitch.tv/videos/…  or  https://kick.com/…"
              disabled={loading}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500 disabled:opacity-50 transition-colors mb-5"
            />
          )}

          {/* File input */}
          {tab === "file" && (
            <label className="block mb-5 cursor-pointer">
              <input
                type="file"
                accept="video/*"
                disabled={loading}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
              <div className="border-2 border-dashed border-gray-700 hover:border-purple-500 rounded-xl p-8 text-center transition-colors">
                {file ? (
                  <>
                    <p className="text-white font-medium">{file.name}</p>
                    <p className="text-gray-400 text-sm mt-1">
                      {(file.size / 1024 / 1024).toFixed(1)} MB — click to change
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-gray-400">Drop a video file or click to browse</p>
                    <p className="text-gray-600 text-sm mt-1">MP4, MKV, WebM…</p>
                  </>
                )}
              </div>
            </label>
          )}

          {/* Settings */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            {/* Clip length */}
            <div>
              <p className="text-xs text-gray-400 mb-2">Clip Length</p>
              <div className="flex gap-1">
                {[15, 30, 45, 60].map((s) => (
                  <button
                    key={s}
                    onClick={() => setClipLength(s)}
                    disabled={loading}
                    className={`flex-1 py-2 text-xs rounded-lg font-medium transition-colors ${
                      clipLength === s
                        ? "bg-purple-600 text-white"
                        : "bg-gray-800 text-gray-400 hover:text-white disabled:opacity-50"
                    }`}
                  >
                    {s}s
                  </button>
                ))}
              </div>
            </div>

            {/* Top N */}
            <div>
              <p className="text-xs text-gray-400 mb-2">Number of Clips</p>
              <div className="flex gap-1">
                {[5, 10, 15, 20].map((n) => (
                  <button
                    key={n}
                    onClick={() => setTopN(n)}
                    disabled={loading}
                    className={`flex-1 py-2 text-xs rounded-lg font-medium transition-colors ${
                      topN === n
                        ? "bg-purple-600 text-white"
                        : "bg-gray-800 text-gray-400 hover:text-white disabled:opacity-50"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Vertical toggle */}
            <div>
              <p className="text-xs text-gray-400 mb-2">Format</p>
              <button
                onClick={() => setVertical((v) => !v)}
                disabled={loading}
                className={`w-full py-2 text-xs rounded-lg font-medium transition-colors disabled:opacity-50 ${
                  vertical
                    ? "bg-purple-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:text-white"
                }`}
              >
                {vertical ? "9:16 Vertical" : "Original"}
              </button>
            </div>
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-800 disabled:text-gray-500 rounded-xl font-semibold text-base transition-colors"
          >
            {loading ? "Processing…" : "Generate Clips"}
          </button>

          {submitError && (
            <p className="mt-3 text-red-400 text-sm text-center">{submitError}</p>
          )}
        </div>

        {/* Progress card */}
        {job && (
          <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 mb-6">
            <div className="flex justify-between items-center mb-3">
              <span className={`font-semibold ${isError ? "text-red-400" : isDone ? "text-green-400" : "text-white"}`}>
                {STATUS_LABELS[job.status] ?? job.status}
                {loading && !isError && (
                  <span className="ml-2 inline-block animate-pulse text-gray-400 font-normal text-sm">
                    {job.clips.length > 0 ? `${job.clips.length} clips so far` : ""}
                  </span>
                )}
              </span>
              <span className="text-gray-400 text-sm tabular-nums">
                {Math.round(job.progress * 100)}%
              </span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-500 ${
                  isError ? "bg-red-500" : isDone ? "bg-green-500" : "bg-purple-500"
                }`}
                style={{ width: `${job.progress * 100}%` }}
              />
            </div>
            {isError && (
              <p className="mt-3 text-red-400 text-sm">{job.error}</p>
            )}
            {isDone && (
              <p className="mt-3 text-green-400 text-sm">
                {job.clips.length} clip{job.clips.length !== 1 ? "s" : ""} ready
              </p>
            )}
          </div>
        )}

        {/* Clips grid */}
        {job?.clips && job.clips.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-200">
              Clips{" "}
              <span className="text-gray-500 font-normal">({job.clips.length})</span>
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {job.clips.map((clip) => (
                <ClipCard key={clip.filename} clip={clip} />
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
