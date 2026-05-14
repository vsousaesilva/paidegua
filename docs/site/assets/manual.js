/*
 * pAIdegua — manual.js
 * TOC active state via IntersectionObserver + busca textual client-side.
 */
(function () {
  'use strict';

  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));

  // ============ TOC active state ============
  const tocLinks = $$('.toc__list a[href^="#"]');
  if (tocLinks.length) {
    const idToLink = new Map();
    tocLinks.forEach((a) => {
      const id = decodeURIComponent(a.getAttribute('href').slice(1));
      idToLink.set(id, a);
    });

    const observer = new IntersectionObserver(
      (entries) => {
        // pick the entry with smallest top among the ones intersecting
        let bestId = null;
        let bestTop = Infinity;
        entries.forEach((e) => {
          if (e.isIntersecting && e.boundingClientRect.top < bestTop) {
            bestTop = e.boundingClientRect.top;
            bestId = e.target.id;
          }
        });
        if (bestId) setActive(bestId);
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    );

    const headings = $$('.manual-content h2[id], .manual-content h3[id]');
    headings.forEach((h) => observer.observe(h));

    function setActive(id) {
      tocLinks.forEach((a) => a.classList.remove('is-active'));
      const a = idToLink.get(id);
      if (a) {
        a.classList.add('is-active');
        a.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      }
    }
  }

  // ============ Mobile drawer ============
  const toc = $('.toc');
  const toggle = $('.toc-toggle');
  if (toc && toggle) {
    toggle.addEventListener('click', () => {
      toc.classList.toggle('is-open');
    });
    // Fechar ao clicar em um link (mobile)
    $$('.toc a').forEach((a) =>
      a.addEventListener('click', () => {
        if (window.matchMedia('(max-width: 900px)').matches) {
          toc.classList.remove('is-open');
        }
      })
    );
    // Fechar com ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') toc.classList.remove('is-open');
    });
  }

  // ============ Busca textual ============
  const searchInput = $('#manual-search');
  if (!searchInput) return;

  const content = $('.manual-content');
  // Coletar todos os blocos pesquisáveis (h2..h4, p, li, td)
  const blocks = $$('h2[id], h3[id], h4, p, li, td', content);
  // Guardar texto original para limpar destaques
  const original = new Map();
  blocks.forEach((el) => original.set(el, el.innerHTML));

  // Mapa headings → seção: cada bloco "pertence" ao último h2 anterior
  const sectionOf = new Map();
  let lastH2 = null;
  $$('.manual-content > *').forEach((el) => {
    if (el.matches('h2[id]')) lastH2 = el;
    if (lastH2) sectionOf.set(el, lastH2);
  });
  // Para blocos aninhados, descobrir o ancestral direto
  function getSection(el) {
    let p = el;
    while (p && p.parentElement !== content) p = p.parentElement;
    return sectionOf.get(p);
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function normalize(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  // Resetar todos destaques + exibir tudo
  function reset() {
    blocks.forEach((el) => {
      el.innerHTML = original.get(el);
      el.style.display = '';
    });
    $$('.toc__list a').forEach((a) => {
      a.style.display = '';
      a.innerHTML = a.dataset.originalText || a.textContent;
    });
    removeNoResults();
  }

  function removeNoResults() {
    const existing = $('.toc__no-results');
    if (existing) existing.remove();
  }

  // Inicializar dataset.originalText pra TOC
  $$('.toc__list a').forEach((a) => {
    a.dataset.originalText = a.textContent;
  });

  function search(term) {
    if (!term || term.trim().length < 2) {
      reset();
      return;
    }
    const normTerm = normalize(term.trim());
    const re = new RegExp(escapeRegex(term.trim()), 'gi');

    // Marcar quais seções têm matches
    const matchedSections = new Set();
    blocks.forEach((el) => {
      const text = el.textContent;
      if (normalize(text).includes(normTerm)) {
        // Destacar matches
        el.innerHTML = original.get(el).replace(re, (m) => `<mark class="search-hit">${escapeHtml(m)}</mark>`);
        const sec = getSection(el);
        if (sec) matchedSections.add(sec.id);
        // Se o bloco é heading, conta também a própria seção
        if (el.tagName === 'H2' || el.tagName === 'H3') matchedSections.add(el.id);
      }
    });

    // Filtrar TOC: mostrar só links cujo id está em matchedSections
    let visibleCount = 0;
    $$('.toc__list a').forEach((a) => {
      const id = decodeURIComponent(a.getAttribute('href').slice(1));
      if (matchedSections.has(id)) {
        a.style.display = '';
        visibleCount++;
      } else {
        a.style.display = 'none';
      }
    });

    removeNoResults();
    if (visibleCount === 0) {
      const msg = document.createElement('p');
      msg.className = 'toc__no-results';
      msg.textContent = 'Nenhum resultado para "' + term + '"';
      $('.toc__list').parentElement.appendChild(msg);
    }
  }

  let debounceTimer;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const value = e.target.value;
    debounceTimer = setTimeout(() => search(value), 120);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      reset();
      searchInput.blur();
    }
  });

  // Atalho: "/" foca a busca
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      searchInput.focus();
    }
  });
})();
