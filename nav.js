// サイト共通の上部メニュー（正本）。見た目は site.css。各ページは <body> 直後に
//   <script src="nav.js" data-page="upload|result"></script>
// を置くだけ。メニュー項目・リンク先・「前回の IIDX ID」の保存キーはここだけで持つ。
(function () {
  "use strict";
  const LAST_TOKEN_KEY = "last_token";          // 前回使った IIDX ID(数字8桁)。index.html もこれを使う
  const qp = new URLSearchParams(location.search);
  const api = qp.get("api");                     // ?api=<host> の一時上書きはページ間で引き継ぐ
  function lastToken() { try { return localStorage.getItem(LAST_TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function withApi(u) { return api ? u + (u.includes("?") ? "&" : "?") + "api=" + encodeURIComponent(api) : u; }
  function resultUrl(token) { return withApi("view" + (token ? "?u=" + encodeURIComponent(token) : "")); }

  const me = document.currentScript, cur = me && me.dataset.page;
  // main(本番)には結果ページ(view.html)と backend の /u/{token}/results がまだ無いので「結果」は出さない。
  // view.html を main に入れたら develop と同じく ["result", "結果", resultUrl(lastToken())] を戻す。
  const items = [["upload", "アップロード", withApi("./")], ["sim", "似た譜面", "sim/"]];
  const html = `<nav id="sitenav">`
    + items.map(([k, label, href]) => `<a href="${href}"${k === cur ? ' class="cur"' : ""}>${label}</a>`).join("")
    + "</nav>";
  if (me) me.insertAdjacentHTML("beforebegin", html);
  window.SiteNav = { LAST_TOKEN_KEY, resultUrl, lastToken };
})();
