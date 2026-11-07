(function () {
  var SITE = 'https://moonroom.stream/tv';
  // Answers with a CORS header only when the site is really up: when the server or the tunnel is
  // down, Cloudflare's error page has none, so the request fails and the moon shows instead.
  var PING = 'https://moonroom.stream/api/ping';
  var msg = document.getElementById('msg');
  var sub = document.getElementById('sub');
  var actions = document.getElementById('actions');
  var quit = document.getElementById('quit');
  var BACK = 10009;
  var pt = /^pt/i.test(navigator.language || '');
  var TEXT = pt
    ? { loading: 'Carregando…', wait: 'Reconectando…', waitSub: 'A lua já volta', off: 'O MoonRoom está fora do ar', offSub: 'Ainda tentando a cada poucos segundos. Pode deixar aberto.', exit: 'Sair' }
    : { loading: 'Loading…', wait: 'Reconnecting…', waitSub: 'The moon will be back in a moment', off: 'MoonRoom is offline', offSub: 'Still trying every few seconds. You can leave this open.', exit: 'Exit' };
  var started = 0;

  function exit() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
  }

  function openSite() {
    location.replace(SITE);
  }

  function offline() {
    var long = Date.now() - started > 60000;
    document.body.className = long ? 'off' : '';
    msg.textContent = long ? TEXT.off : TEXT.wait;
    sub.textContent = long ? TEXT.offSub : TEXT.waitSub;
    actions.hidden = !long;
    if (long) quit.focus();
  }

  function check() {
    var timer = setTimeout(function () { fail(); }, 6000);
    var over = false;
    function fail() {
      if (over) return;
      over = true; clearTimeout(timer);
      if (!started) started = Date.now();
      offline();
      setTimeout(check, 4000);
    }
    fetch(PING, { mode: 'cors', cache: 'no-store' }).then(function (r) {
      if (over) return;
      if (!r.ok) { fail(); return; }
      over = true; clearTimeout(timer); openSite();
    }, fail);
  }

  quit.textContent = TEXT.exit;
  msg.textContent = TEXT.loading;
  quit.addEventListener('click', exit);
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === BACK) exit();
  });
  check();
})();
