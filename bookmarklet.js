/* e-amusement(eagate) 上で実行するブックマークレット本体。gsv.fun (Gitadora Skill Viewer) と同じ方式。
 *
 * 流れ:
 *   1. ログイン済みの eagate ページ上で、同一オリジン fetch で SP スコアデータ CSV と IIDX ID を取る
 *      - CSV : POST /game/2dx/{ver}/djdata/score_download.html  style=SP
 *              (フォーム実物 2026-09-24 確認: <input type=submit name=style value=SP>)
 *      - ID  : /game/2dx/{ver}/djdata/status.html の「IIDX ID」近傍の NNNN-NNNN
 *      - ver : /game/2dx/ が現行版 /game/2dx/{ver}/ にリダイレクトするのを使う(版の直書きをしない)
 *      - 取る版 = 現行版と1つ前(2026-09 時点で ZINRAI 34 + Sparkle Shower 33)。版が上がると
 *              スコア/BP が消えてランプだけ残るので、旧版サイトの CSV に前作の記録が残っている
 *              (db/init/41_official_game_version.sql)。旧版サイトも同じフォームで CSV を返す
 *              (/game/2dx/33/djdata/score_download.html のフォーム実物 2026-09-24 確認)。
 *              版の判定は backend が CSV の中身(最終行の「バージョン」列)で行うので、ここでは版を送らない。
 *   2. 押した直後(取得完了を待たず)に pages.dev のページを新しいタブで開き、取得が終わったら
 *      postMessage で渡す(gsv.fun の「自動で遷移」と同じ体験)。クリック直後なのでポップアップ許可の
 *      猶予内に window.open できる。ブロックされた時だけオーバーレイにボタンを出して手で開かせる。
 *      取得に失敗したら開いたタブにも理由を送る({type: "iidx-est:error", message})。
 *      **サーバーへの送信はしない**。pages.dev 側で対象レベル等を確認して
 *      ユーザーが「アップロードして生成」を押す(既存の貼り付け経路 POST /jobs/text と完全共通)。
 *
 * backend の住所(トンネルURL)をここに持たないのは意図的: 住所の正本は index.html の DEFAULT_API で、
 * watchdog / redeploy_frontend.sh がそこだけを焼き直す。ここに2つ目を書くとトンネル変更時に黙って壊れる。
 *
 * postMessage 契約 (相手は index.html の「eagate 連携」節):
 *   予測ページ(pages.dev) → opener : {type: "iidx-est:ready"}                         (targetOrigin = eagate)
 *   opener → 予測ページ(pages.dev) : {type: "iidx-est:data", iidx_id, csv, version,     (targetOrigin = 予測ページ(pages.dev))
 *                          extra: [{csv, version, label}]}   csv=現行版 / extra=旧版(取れた分だけ)
 */
(function () {
  "use strict";
  var EAGATE_ORIGIN = "https://p.eagate.573.jp";
  var CSV_HEAD = "バージョン,タイトル";      // eagate スコアCSVの先頭(列の正本は acquisition/official_ingest_csv.py)
  var FALLBACK_APP = "https://iidx-estimate.pages.dev/";
  // 予測ページ(pages.dev) = このスクリプト自身の配信元(pages.dev / ローカル確認時は localhost)。
  var APP_URL = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      if (s) return new URL("./", s).href;
    } catch (e) {}
    return FALLBACK_APP;
  })();
  var APP_ORIGIN = new URL(APP_URL).origin;

  if (window.__iidxEst && window.__iidxEst.host && document.body.contains(window.__iidxEst.host)) {
    window.__iidxEst.host.remove();          // 二度押し: 前のオーバーレイを消して取り直す
  }

  // ---- オーバーレイ (Shadow DOM で eagate の CSS から隔離) -------------------------------
  var host = document.createElement("div");
  host.style.cssText = "position:fixed;top:12px;right:12px;left:12px;z-index:2147483647;"
    + "display:flex;justify-content:flex-end;pointer-events:none";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    '<style>'
    + '.box{pointer-events:auto;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;'
    + 'background:#fff;color:#1a1a1a;border:1px solid #d0d0d0;border-radius:10px;'
    + 'box-shadow:0 6px 24px rgba(0,0,0,.18);padding:14px 16px;max-width:380px;width:100%;box-sizing:border-box}'
    + '.h{font-weight:700;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px}'
    + '.x{cursor:pointer;border:0;background:none;font-size:18px;line-height:1;color:#666}'
    + '.line{margin:2px 0}.ok{color:#18794e}.err{color:#c62828}.muted{color:#666;font-size:12px}'
    + 'button.go{margin-top:10px;width:100%;padding:10px;border:0;border-radius:8px;background:#2f6fed;'
    + 'color:#fff;font:inherit;font-weight:700;cursor:pointer}button.go[hidden]{display:none}'
    + '</style>'
    + '<div class="box"><div class="h"><span>プレーデータを取得</span>'
    + '<button class="x" title="閉じる">×</button></div>'
    + '<div id="log"></div><button class="go" hidden></button>'
    + '<div class="muted" id="foot"></div></div>';
  document.body.appendChild(host);
  var logEl = root.getElementById("log"), goBtn = root.querySelector("button.go");
  var footEl = root.getElementById("foot");
  goBtn.textContent = new URL(APP_URL).host + " を開く";     // 造語を使わず開く先をそのまま書く
  root.querySelector("button.x").onclick = function () { host.remove(); };

  function log(text, cls) {
    var d = document.createElement("div");
    d.className = "line " + (cls || "");
    d.textContent = text;
    logEl.appendChild(d);
    return d;
  }
  var state = window.__iidxEst = { host: host, data: null, error: null, errorMsg: null };
  function fail(msg) { state.errorMsg = msg; }   // 開いたタブにも同じ理由を出す(listener が送る)

  if (location.origin !== EAGATE_ORIGIN) {
    log("e-amusement (p.eagate.573.jp) のページを開いてから実行してください。", "err");
    state.error = "wrong-origin";
    return;
  }

  // ---- eagate 取得 ----------------------------------------------------------------------
  function parse(html) { return new DOMParser().parseFromString(html, "text/html"); }

  async function getText(url, opts) {
    var r = await fetch(url, Object.assign({ credentials: "include" }, opts || {}));
    if (!r.ok) throw new Error("HTTP " + r.status + " (" + url + ")");
    return { url: r.url, text: await r.text() };
  }

  // 現行版は開いているページの版でなく /game/2dx/ のリダイレクト先で決める(旧版ページ上で押しても同じ結果)。
  async function currentVersion() {
    var m = null;
    try {
      var r = await getText("/game/2dx/");
      m = new URL(r.url).pathname.match(/^\/game\/2dx\/(\d+)\//);
    } catch (e) {}
    if (!m) m = location.pathname.match(/^\/game\/2dx\/(\d+)\//);   // 取れなければ開いているページの版
    if (!m) throw new Error("現行バージョンを判定できませんでした");
    return Number(m[1]);
  }

  function csvRows(csv) { return csv.split(/\r?\n/).filter(function (s) { return s.trim(); }).length - 1; }
  // 表示名 = CSV 最終行の「バージョン」列(= その CSV の稼働版。backend の版判定と同じ規則)。
  function csvLabel(csv, ver) {
    var lines = csv.split(/\r?\n/).filter(function (s) { return s.trim(); });
    var last = lines.length > 1 ? lines[lines.length - 1].split(",")[0] : "";
    return last || ("IIDX " + ver);
  }

  // CSV は textarea に入って返る(スマホでは「テキストとして表示」)。要素名/ id に依存せず、
  // 先頭が CSV_HEAD の要素を探す。
  function findCsv(doc) {
    var nodes = doc.querySelectorAll("textarea, pre, code");
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].value || nodes[i].textContent || "").replace(/^\s+/, "");
      if (t.indexOf(CSV_HEAD) === 0) return t;
    }
    return null;
  }

  async function fetchCsv(ver) {
    var url = "/game/2dx/" + ver + "/djdata/score_download.html";
    var r = await getText(url, { method: "POST", body: new URLSearchParams({ style: "SP" }) });
    return findCsv(parse(r.text));
  }

  async function fetchIidxId(ver) {
    var r = await getText("/game/2dx/" + ver + "/djdata/status.html");
    var txt = (parse(r.text).body || {}).textContent || "";
    txt = txt.replace(/\s+/g, " ");
    var i = txt.indexOf("IIDX ID");
    var m = i >= 0 ? txt.slice(i, i + 80).match(/(\d{4})-(\d{4})/) : null;
    return m ? m[1] + "-" + m[2] : null;
  }

  async function run() {
    var ver = await currentVersion();
    var l1 = log("スコアデータ (SP) を取得中…");
    var csv = await fetchCsv(ver);
    if (!csv) {
      l1.textContent = "スコアデータ CSV を取得できませんでした。";
      l1.className = "line err";
      log("e-amusement にログインしているか、スコアデータのダウンロード"
        + "（ベーシックコース加入が必要）が使える状態かを確認してください。", "muted");
      state.error = "no-csv";
      fail("スコアデータを取得できませんでした。e-amusement にログインしているか、ベーシックコースに加入しているかを確認してください。");
      return;
    }
    l1.textContent = "✓ " + csvLabel(csv, ver) + " " + csvRows(csv) + " 曲";
    l1.className = "line ok";

    // 1つ前の版。未プレー・サイト終了などで取れなくても現行版だけで続行する。
    var extra = [], prev = ver - 1;
    var lp = log("前作のスコアデータを取得中…");
    try {
      var pcsv = await fetchCsv(prev);
      if (pcsv && csvRows(pcsv) > 0) {
        extra.push({ csv: pcsv, version: String(prev), label: csvLabel(pcsv, prev) });
        lp.textContent = "✓ " + csvLabel(pcsv, prev) + " " + csvRows(pcsv) + " 曲";
        lp.className = "line ok";
      } else {
        lp.textContent = "前作のスコアデータはありませんでした"; lp.className = "line muted";
      }
    } catch (e) {
      lp.textContent = "前作のスコアデータは取れませんでした"; lp.className = "line muted";
    }

    // IIDX ID は小窓に出さない(オーナー指示 2026-09-24)。取れなければ開いたページの ID 欄で入力してもらう。
    var id = null;
    try { id = await fetchIidxId(ver); } catch (e) {}

    state.data = { type: "iidx-est:data", iidx_id: id, csv: csv, version: String(ver), extra: extra };
    if (!state.win) {                      // 自動で開けなかった時だけボタンで開かせる
      goBtn.hidden = false;
      footEl.textContent = "押すとプレーデータが入った状態でページが開きます。";
    } else {
      footEl.textContent = "開いたタブに渡しています…";
    }
  }

  // ---- 予測ページ(pages.dev)へ受け渡し ---------------------------------------------------------------
  // 自動で開けなかった時(ポップアップブロック)用。クリック起点なら必ず開ける。
  goBtn.onclick = function () {
    var w = window.open(APP_URL + "?from=eagate", "_blank");
    if (!w) { log("ポップアップがブロックされました。許可してからもう一度押してください。", "err"); return; }
    footEl.textContent = "開いたページに渡しています…";
  };
  // リスナーは1回だけ登録し、常に最新の実行(window.__iidxEst)のデータを渡す(二度押しで重複送信しない)。
  if (!window.__iidxEstListening) {
    window.__iidxEstListening = true;
    window.addEventListener("message", function (ev) {
      var st = window.__iidxEst;
      if (ev.origin !== st.appOrigin || !ev.data || ev.data.type !== "iidx-est:ready") return;
      if (st.data) { ev.source.postMessage(st.data, st.appOrigin); st.onSent(); }
      else if (st.errorMsg) ev.source.postMessage({ type: "iidx-est:error", message: st.errorMsg }, st.appOrigin);
    });
  }
  state.appOrigin = APP_ORIGIN;
  state.onSent = function () { footEl.textContent = "✓ 渡しました。このタブは閉じて構いません。"; };

  // 押した直後に開く(取得を待つとクリックの猶予が切れてポップアップブロックされる)。
  try { state.win = window.open(APP_URL + "?from=eagate", "_blank"); } catch (e) { state.win = null; }

  run().catch(function (e) {
    log("エラー: " + (e && e.message ? e.message : e), "err");
    state.error = String(e);
    fail("プレーデータの取得中にエラーが起きました: " + (e && e.message ? e.message : e));
  });
})();
