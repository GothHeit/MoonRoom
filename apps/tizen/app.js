(function () {
  var URL = 'https://moonroom.stream/tv';
  var msg = document.getElementById('msg');
  var actions = document.getElementById('actions');
  var retry = document.getElementById('retry');
  var quit = document.getElementById('quit');
  var BACK = 10009;

  function exit() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
  }

  function openSite() {
    location.replace(URL);
  }

  function fail() {
    msg.textContent = 'Can’t reach MoonRoom. Check the TV’s internet connection.';
    actions.hidden = false;
    retry.focus();
  }

  function start() {
    actions.hidden = true;
    msg.textContent = 'Loading…';
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; fail(); } }, 8000);
    // A cross-origin no-cors request only tells us whether the site is reachable at all.
    fetch(URL, { mode: 'no-cors', cache: 'no-store' }).then(function () {
      if (done) return;
      done = true; clearTimeout(timer); openSite();
    }, function () {
      if (done) return;
      done = true; clearTimeout(timer); fail();
    });
  }

  retry.addEventListener('click', start);
  quit.addEventListener('click', exit);
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === BACK) exit();
  });
  start();
})();
