/**
 * The app's own website (for example shopeleader.ae, published from GitHub Pages).
 *
 * Google's app verification needs every web address on the sign-in screens to be on a domain the administrator
 * owns. script.google.com belongs to Google, so after "Sign in with Google" / "Connect a Gmail account" Google sends
 * people to https://<your site>/oauth/ instead: a tiny page there passes them straight on to the app (with nothing
 * else). It is switched on by the administrator in Settings, only after the page is really online.
 */
const SITE_PROP = 'PUBLIC_SITE';
const SITE_MARKER = 'sf-oauth-forwarder';

/** Run in the Apps Script editor if sign-in ever stops working after switching the website on: back to the app link. */
function useAppLinkForSignIn() {
  if (CURRENT_EMAIL || norm_(Session.getActiveUser().getEmail()) !== norm_(Session.getEffectiveUser().getEmail())) {
    throw new Error('Run this in the Apps Script editor.');
  }
  sp_().deleteProperty(SITE_PROP);
  return 'Done: Google sends people back to the app link again.';
}

function publicSite_() {
  const s = String(sp_().getProperty(SITE_PROP) || '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

function siteRedirectUri_() {
  const s = publicSite_();
  return s ? 'https://' + s + '/oauth/' : '';
}

/** Admin: use (or stop using, with '') the app's own website for Google's return address. */
function saveWebsite(domain) {
  requireAdmin_();
  let d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) {
    sp_().deleteProperty(SITE_PROP);
    return { site: '', redirectUri: redirectUri_() };
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error('Write only the website name, for example shopeleader.ae');
  // The page must be online and point to THIS app; otherwise everyone's sign-in would break.
  let res;
  try {
    res = UrlFetchApp.fetch('https://' + d + '/oauth/', { muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    throw new Error('https://' + d + '/oauth/ cannot be opened yet (' + (e && e.message ? e.message : e) + '). Wait until the website works, then try again.');
  }
  const html = res.getResponseCode() === 200 ? res.getContentText() : '';
  const appUrl = typeof APP_URL !== 'undefined' ? String(APP_URL) : String(ScriptApp.getService().getUrl() || '');
  if (html.indexOf(SITE_MARKER) === -1 || html.indexOf(appUrl) === -1) {
    throw new Error('https://' + d + '/oauth/ is not the app\'s return page yet (it must be online and contain this app\'s link). Publish the website first, then try again.');
  }
  sp_().setProperty(SITE_PROP, d);
  return { site: d, redirectUri: redirectUri_() };
}
