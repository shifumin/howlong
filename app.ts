"use strict";

/* ===== 型定義 ===== */
// 1件の記録（開始・終了・分）
interface RecordItem {
  start: string;
  end: string;
  minutes: number;
}
// 1つの活動（夕食など）
interface Activity {
  id: string;
  name: string;
  plannedMinutes: number | null;
  records: RecordItem[];
}
// 計測中の状態
interface Running {
  activityId: string;
  start: number;         // 現在の計測セグメントの開始時刻(ms)。一時停止からの再開のたびに更新される
  firstStart: number;    // 計測を最初に開始した時刻(ms)。記録の開始日時表示に使う（再開しても変わらない）
  accumulatedMs: number;  // これまでに実行済みだった時間の合計(ms)
  paused: boolean;        // 一時停止中かどうか
}
// localStorage に保存するデータ全体
interface DB {
  activities: Activity[];
  runnings: Running[];   // 計測中の活動。1つの activityId につき最大1件
}
// 活動ごとの統計
interface Stats {
  avg: number | null;
  med: number | null;
  count: number;
  latest: number | null;
}

const STORAGE_KEY = "howlong.v1";

// 要素取得ヘルパー。<T> で取りたい要素の型を指定できる（既定は HTMLElement）
function $<T extends Element = HTMLElement>(sel: string, el: ParentNode = document): T {
  return el.querySelector(sel) as unknown as T;
}

/* ---------- state ---------- */
let state: DB = load();

// 旧バージョンの localStorage データ（accumulatedMs/paused/firstStart が無い running）を補完する
function normalizeRunning(r: Partial<Running> | null | undefined): Running | null {
  if (!r || typeof r.activityId !== "string" || typeof r.start !== "number") return null;
  return {
    activityId: r.activityId,
    start: r.start,
    firstStart: typeof r.firstStart === "number" ? r.firstStart : r.start,
    accumulatedMs: typeof r.accumulatedMs === "number" ? r.accumulatedMs : 0,
    paused: typeof r.paused === "boolean" ? r.paused : false,
  };
}

// 新形式(runnings 配列)と旧形式(running 単一オブジェクト)の両方から計測中リストを復元する。
// 同じ activityId が重複していたら先勝ちで捨てる（1活動1計測の不変条件を読み込み時に担保する）
function normalizeRunnings(parsed: { runnings?: unknown; running?: Partial<Running> | null }): Running[] {
  if (Array.isArray(parsed.runnings)) {
    const out: Running[] = [];
    for (const raw of parsed.runnings) {
      const r = normalizeRunning(raw as Partial<Running>);
      if (r && !out.some((x) => x.activityId === r.activityId)) out.push(r);
    }
    return out;
  }
  const single = normalizeRunning(parsed.running);
  return single ? [single] : [];
}

function load(): DB {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { activities?: unknown; runnings?: unknown; running?: Partial<Running> | null };
      if (parsed && Array.isArray(parsed.activities)) {
        // 古いデータに runnings が無くても running / 空配列で補う
        return { activities: parsed.activities as Activity[], runnings: normalizeRunnings(parsed) };
      }
    }
  } catch (e) { /* fall through to default */ }
  return { activities: [], runnings: [] };
}

function save(): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      toast("保存容量がいっぱいです。エクスポートしてください");
    } else {
      toast("保存に失敗しました");
    }
    return false;
  }
}

/* ---------- helpers ---------- */
function uid(): string {
  return "a" + Date.now().toString(36) + Math.floor(performance.now() * 1000).toString(36);
}

// ms -> "YYYY-MM-DDTHH:MM" in local time (minute precision)
function toLocalMinuteISO(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function localMinuteISONow(): string { return toLocalMinuteISO(Date.now()); }
function parseLocalISO(s: string): number {
  // "YYYY-MM-DDTHH:MM" treated as local time
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || "");
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}
function fmtDate(iso: string): string {
  const t = parseLocalISO(iso);
  if (isNaN(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function average(arr: number[]): number | null {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function fmtMin(v: number | null): string {
  if (v == null) return "—";
  return Math.round(v) + "分";
}

// 指定した活動が計測中ならその Running を返す
function findRunning(activityId: string): Running | undefined {
  return state.runnings.find((r) => r.activityId === activityId);
}

/* ---------- timer ---------- */
let tick: number | null = null;

// 計測中(一時停止していない)活動が1つ以上ある間だけ毎秒更新を回す。
// 呼び出し側は「回すべきか」を判断せず、状態を変えたらこれを呼ぶだけでよい
function syncTimerLoop(): void {
  const needed = state.runnings.some((r) => !r.paused);
  if (needed && tick == null) {
    tick = setInterval(tickBanner, 1000);
  } else if (!needed && tick != null) {
    clearInterval(tick);
    tick = null;
  }
}

// バナー周りの再同期の唯一の入口。状態を変えたあとに必ずこれを呼ぶ
function refreshRunning(): void {
  // 削除済みの活動を指す計測が残っていたら捨てる（自己修復）
  const alive = state.runnings.filter((r) => state.activities.some((a) => a.id === r.activityId));
  if (alive.length !== state.runnings.length) {
    state.runnings = alive;
    save();
  }
  renderBanner();
  tickBanner();
  syncTimerLoop();
}

// 一時停止時間を除いた実働の経過時間(ms)を返す
function elapsedMs(running: Running): number {
  return running.paused ? running.accumulatedMs : running.accumulatedMs + (Date.now() - running.start);
}

// 経過ミリ秒を "MM:SS"（1時間以上は "H:MM:SS"）に整形する
function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

// バナーの行を作り直す。開始・終了・やめる・一時停止・再開のたびに呼ぶ（毎秒は呼ばない）
function renderBanner(): void {
  const banner = $("#runningBanner");
  banner.innerHTML = "";
  const runnings = state.runnings;
  banner.classList.toggle("show", runnings.length > 0);
  // 2件以上のときは行を詰めて縦に伸びすぎないようにする
  banner.classList.toggle("multi", runnings.length > 1);

  for (const r of runnings) {
    const act = state.activities.find((a) => a.id === r.activityId);
    if (!act) continue;
    const armed = armedCancels.has(r.activityId);
    const row = document.createElement("div");
    row.className = "rb-row" + (r.paused ? " paused" : "");
    row.dataset.id = r.activityId;
    row.innerHTML = `
      <div class="rb-head">
        <div class="rb-name"></div>
        <div class="rb-time">00:00</div>
      </div>
      <div class="rb-actions">
        <button class="rb-cancel${armed ? " armed" : ""}">${armed ? "破棄？" : "やめる"}</button>
        <button class="rb-pause${r.paused ? " paused" : ""}">${r.paused ? "再開" : "一時停止"}</button>
        <button class="rb-stop">終了</button>
      </div>
    `;
    $(".rb-name", row).textContent = act.name + (r.paused ? " を一時停止中" : " を計測中");
    $(".rb-cancel", row).onclick = () => cancelActivity(r.activityId);
    $(".rb-pause", row).onclick = () => {
      if (findRunning(r.activityId)?.paused) resumeActivity(r.activityId);
      else pauseActivity(r.activityId);
    };
    $(".rb-stop", row).onclick = () => stopActivity(r.activityId);
    banner.appendChild(row);
  }

  // バナーの高さは行数で変わるので、最後のカードが隠れない余白を実測して確保する
  document.body.style.paddingBottom = runnings.length
    ? `calc(env(safe-area-inset-bottom) + ${banner.offsetHeight + 28}px)`
    : "";
}

// 毎秒呼ばれる。各行の経過時間のテキストだけを更新し、DOM 構造やクラスには触らない。
// 行を作り直すと「破棄？」の armed 表示やフォーカスが1秒で失われるため分けている
function tickBanner(): void {
  const rows = document.querySelectorAll<HTMLElement>("#runningBanner .rb-row");
  rows.forEach((row) => {
    const r = findRunning(row.dataset.id || "");
    if (!r) return;
    $(".rb-time", row).textContent = fmtElapsed(elapsedMs(r));
  });
}

function startActivity(id: string): void {
  if (findRunning(id)) { toast("この活動はすでに計測中です"); return; }
  const now = Date.now();
  state.runnings.push({ activityId: id, start: now, firstStart: now, accumulatedMs: 0, paused: false });
  save();
  refreshRunning();
  render();
}
function pauseActivity(id: string): void {
  const running = findRunning(id);
  if (!running || running.paused) return;
  running.accumulatedMs += Date.now() - running.start;
  running.paused = true;
  save();
  refreshRunning();
}
function resumeActivity(id: string): void {
  const running = findRunning(id);
  if (!running || !running.paused) return;
  running.start = Date.now();
  running.paused = false;
  save();
  refreshRunning();
}
function stopActivity(id: string): void {
  const running = findRunning(id);
  if (!running) return;
  clearArmed(id);
  const act = state.activities.find((a) => a.id === id);
  const startMs = running.firstStart;
  const endMs = Date.now();
  const minutes = Math.max(1, Math.round(elapsedMs(running) / 60000));
  state.runnings = state.runnings.filter((r) => r.activityId !== id);
  if (act) {
    act.records.push({ start: toLocalMinuteISO(startMs), end: toLocalMinuteISO(endMs), minutes });
  }
  save();
  refreshRunning();
  render();
  if (act) toast("記録しました");
}

// 計測の取り消し（記録を残さない）。誤タップ防止に2段階確認。
// armed 状態は活動ごとに持つ。行を作り直しても Map から表示を復元できる
const armedCancels = new Map<string, number>();

// armed 解除のみ（再描画しない）。他の処理の途中から呼ぶ用
function clearArmed(id: string): void {
  const t = armedCancels.get(id);
  if (t != null) clearTimeout(t);
  armedCancels.delete(id);
}
// armed 解除して表示も戻す。3秒の自動解除タイマーはこちらを使う
function disarmCancel(id: string): void {
  clearArmed(id);
  renderBanner();
}
function cancelActivity(id: string): void {
  if (!findRunning(id)) return;
  if (!armedCancels.has(id)) {
    armedCancels.set(id, window.setTimeout(() => disarmCancel(id), 3000));
    renderBanner();
    return;
  }
  clearArmed(id);
  state.runnings = state.runnings.filter((r) => r.activityId !== id);
  save();
  refreshRunning();
  render();
  toast("計測をやめました");
}

/* ---------- mutations ---------- */
function addActivity(name: string): void {
  name = name.trim();
  if (!name) return;
  if (state.activities.some((a) => a.name === name)) { toast("同じ名前の活動があります"); return; }
  state.activities.push({ id: uid(), name, plannedMinutes: null, records: [] });
  save();
  render();
}
function moveActivity(id: string, dir: number): void {
  const i = state.activities.findIndex((a) => a.id === id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= state.activities.length) return;
  const arr = state.activities;
  const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  save();
  render();
}
function renameActivity(id: string): void {
  const act = state.activities.find((a) => a.id === id);
  if (!act) return;
  const v = prompt("活動の名前を変更", act.name);
  if (v === null) return;
  const name = v.trim();
  if (!name) { toast("名前を入力してください"); return; }
  if (state.activities.some((a) => a.id !== id && a.name === name)) { toast("同じ名前の活動があります"); return; }
  act.name = name;
  save();
  render();
}
function deleteActivity(id: string): void {
  state.activities = state.activities.filter((a) => a.id !== id);
  state.runnings = state.runnings.filter((r) => r.activityId !== id);
  clearArmed(id);
  save();
  refreshRunning();
  render();
}
function setPlanned(id: string, val: string): void {
  const act = state.activities.find((a) => a.id === id);
  if (!act) return;
  const n = parseInt(val, 10);
  act.plannedMinutes = isNaN(n) || n <= 0 ? null : n;
  save();
  render();
}
function addManualRecord(id: string, dateISO: string, minutes: string): boolean {
  const act = state.activities.find((a) => a.id === id);
  if (!act) return false;
  const min = parseInt(minutes, 10);
  if (isNaN(min) || min < 1) { toast("分は1以上で入力してください"); return false; }
  const startMs = parseLocalISO(dateISO);
  const start = isNaN(startMs) ? localMinuteISONow() : dateISO;
  const sMs = parseLocalISO(start);
  act.records.push({ start, end: toLocalMinuteISO(sMs + min * 60000), minutes: min });
  save();
  render();
  return true;
}
function updateRecordMinutes(id: string, idx: number, minutes: string): void {
  const act = state.activities.find((a) => a.id === id);
  if (!act || !act.records[idx]) return;
  const min = parseInt(minutes, 10);
  if (isNaN(min) || min < 1) return;
  const rec = act.records[idx];
  rec.minutes = min;
  const sMs = parseLocalISO(rec.start);
  if (!isNaN(sMs)) rec.end = toLocalMinuteISO(sMs + min * 60000);
  save();
  render();
}
function deleteRecord(id: string, idx: number): void {
  const act = state.activities.find((a) => a.id === id);
  if (!act) return;
  act.records.splice(idx, 1);
  save();
  render();
}

/* ---------- export / import ---------- */
function exportJSON(): void {
  const data = JSON.stringify({ activities: state.activities }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  a.href = url;
  a.download = `howlong-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importJSON(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result as string);
      if (!parsed || !Array.isArray(parsed.activities)) throw new Error("invalid");
      // normalize
      const activities: Activity[] = parsed.activities.map((a: any): Activity => ({
        id: a.id || uid(),
        name: String(a.name || "無名"),
        plannedMinutes: (typeof a.plannedMinutes === "number" && a.plannedMinutes > 0) ? a.plannedMinutes : null,
        records: Array.isArray(a.records)
          ? a.records
              .filter((r: any) => r && typeof r.minutes === "number")
              .map((r: any): RecordItem => ({
                start: r.start || "", end: r.end || "", minutes: Math.max(1, Math.round(r.minutes)),
              }))
          : [],
      }));
      if (!confirm(`${activities.length}件の活動を読み込み、現在のデータを置き換えます。よろしいですか？`)) return;
      state.activities = activities;
      state.runnings = [];
      armedCancels.forEach((t) => clearTimeout(t));
      armedCancels.clear();
      save();
      refreshRunning();
      render();
      toast("インポートしました");
    } catch (e) {
      toast("読み込めませんでした（JSON形式を確認）");
    }
  };
  reader.readAsText(file);
}

/* ---------- render ---------- */
function statsOf(act: Activity): Stats {
  const mins = act.records.map((r) => r.minutes);
  return {
    avg: average(mins),
    med: median(mins),
    count: mins.length,
    latest: mins.length ? act.records[act.records.length - 1].minutes : null,
  };
}

const expanded = new Set<string>();

function render(): void {
  const list = $("#list");
  list.innerHTML = "";

  if (!state.activities.length) {
    list.innerHTML = '<div class="empty">活動がまだありません。<br>上の入力欄から追加してください。</div>';
    return;
  }

  const activities = state.activities;
  for (let idx = 0; idx < activities.length; idx++) {
    const act = activities[idx];
    const isFirst = idx === 0;
    const isLast = idx === activities.length - 1;
    const st = statsOf(act);
    const over = act.plannedMinutes != null && st.avg != null && st.avg > act.plannedMinutes;
    const card = document.createElement("div");
    card.className = "card";

    const plannedLabel = act.plannedMinutes != null
      ? `予定 <b>${act.plannedMinutes}分</b>`
      : `予定 未設定`;

    card.innerHTML = `
      <div class="card-head">
        <div>
          <div class="name"></div>
          <div class="planned">${plannedLabel}${over ? ' <span style="color:var(--danger)">⚠ 平均が予定超過</span>' : ''}</div>
        </div>
        <div class="head-actions">
          <button class="subtle up" title="上へ移動">▲</button>
          <button class="subtle down" title="下へ移動">▼</button>
          <button class="subtle rename" title="名前を変更">✏️</button>
          <button class="subtle del" title="活動を削除">🗑</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat ${over ? 'warn' : ''}"><div class="v">${fmtMin(st.avg)}</div><div class="l">平均</div></div>
        <div class="stat"><div class="v">${fmtMin(st.med)}</div><div class="l">中央値</div></div>
        <div class="stat"><div class="v">${st.count}</div><div class="l">回数</div></div>
        <div class="stat"><div class="v">${fmtMin(st.latest)}</div><div class="l">最新</div></div>
      </div>
      <div class="card-actions">
        <button class="start">▶ 開始</button>
        <button class="ghost plan">予定を設定</button>
        <button class="ghost hist">履歴 (${st.count})</button>
      </div>
      <div class="history" hidden></div>
    `;
    $(".name", card).textContent = act.name;

    const upBtn = $<HTMLButtonElement>(".up", card);
    upBtn.disabled = isFirst;
    upBtn.onclick = () => moveActivity(act.id, -1);
    const downBtn = $<HTMLButtonElement>(".down", card);
    downBtn.disabled = isLast;
    downBtn.onclick = () => moveActivity(act.id, 1);
    $(".rename", card).onclick = () => renameActivity(act.id);

    const startBtn = $<HTMLButtonElement>(".start", card);
    const isRunning = !!findRunning(act.id);
    startBtn.disabled = isRunning;
    startBtn.textContent = isRunning ? "計測中…" : "▶ 開始";
    startBtn.onclick = () => startActivity(act.id);

    $(".del", card).onclick = () => {
      if (confirm(`「${act.name}」と全ての記録を削除します。よろしいですか？`)) deleteActivity(act.id);
    };

    $(".plan", card).onclick = () => {
      const cur = act.plannedMinutes != null ? String(act.plannedMinutes) : "";
      const v = prompt(`「${act.name}」の予定時間（分）を入力。空欄で解除。`, cur);
      if (v === null) return;
      setPlanned(act.id, v);
    };

    const histEl = $(".history", card);
    const histBtn = $(".hist", card);
    if (expanded.has(act.id)) histEl.hidden = false;
    histBtn.onclick = () => {
      histEl.hidden = !histEl.hidden;
      if (histEl.hidden) expanded.delete(act.id); else expanded.add(act.id);
    };
    renderHistory(histEl, act);

    list.appendChild(card);
  }
}

function renderHistory(el: HTMLElement, act: Activity): void {
  el.innerHTML = "";
  const recs = act.records;
  if (recs.length) {
    // newest first
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i];
      const row = document.createElement("div");
      row.className = "rec";
      row.innerHTML = `
        <div class="rec-main">
          <span class="rec-min">${r.minutes}分</span>
          <span class="rec-date">${fmtDate(r.start)}</span>
        </div>
        <div class="rec-actions">
          <button class="ghost edit">編集</button>
          <button class="danger del">削除</button>
        </div>
      `;
      $(".edit", row).onclick = () => {
        const v = prompt("分を編集", String(r.minutes));
        if (v === null) return;
        updateRecordMinutes(act.id, i, v);
      };
      $(".del", row).onclick = () => deleteRecord(act.id, i);
      el.appendChild(row);
    }
  } else {
    const none = document.createElement("div");
    none.className = "rec-date";
    none.style.padding = "4px 0";
    none.textContent = "記録はまだありません";
    el.appendChild(none);
  }

  // manual add row
  const manual = document.createElement("div");
  manual.className = "manual-row";
  manual.innerHTML = `
    <input class="date" type="datetime-local" value="${localMinuteISONow()}">
    <input class="min" type="number" min="1" inputmode="numeric" placeholder="分">
    <button class="ghost addrec">手入力で追加</button>
  `;
  $(".addrec", manual).onclick = () => {
    const date = $<HTMLInputElement>(".date", manual).value;
    const min = $<HTMLInputElement>(".min", manual).value;
    if (addManualRecord(act.id, date, min)) toast("追加しました");
  };
  el.appendChild(manual);
}

/* ---------- toast ---------- */
let toastTimer: number | undefined;
function toast(msg: string): void {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ---------- events ---------- */
$("#addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $<HTMLInputElement>("#addInput");
  addActivity(inp.value);
  inp.value = "";
});
$("#exportBtn").addEventListener("click", exportJSON);
$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files && input.files[0];
  if (f) importJSON(f);
  input.value = "";
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tickBanner();
});

/* ---------- boot ---------- */
render();
refreshRunning();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
