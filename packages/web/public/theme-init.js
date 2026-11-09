// Apply the saved theme before first paint so dark mode never flashes white.
// A separate same-origin file (not an inline script) so the Docker image's
// Content-Security-Policy (script-src 'self') can stay strict.
try {
  var theme = localStorage.getItem("finesign_theme") || "system";
  var dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
} catch (e) {
  // Storage unavailable (private mode): fall back to the light theme.
}
