// Tema claro ou escuro. O <script> do <head> do index.html já define data-theme antes da primeira pintura; aqui ficam a
// troca e a escolha guardada no localStorage (bizas.theme), só neste navegador

export const getTheme = () => document.documentElement.dataset.theme;

function mark() {
  for (const b of document.querySelectorAll("[data-theme-set]")) {
    b.setAttribute("aria-pressed", String(b.dataset.themeSet === getTheme()));
  }
}

export function setTheme(theme) {
  if (theme !== "light" && theme !== "dark") return;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("bizas.theme", theme); } catch { /* sem localStorage: vale só nesta aba */ }
  mark();
}

export const initTheme = mark;
