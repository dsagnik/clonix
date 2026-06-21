/**
 * main.js
 * --------
 * Client-side logic for Clonix.
 * Handles SPA-like view switching, cloning API calls, progress polling,
 * FAQ accordion, scroll-reveal animations, and floating particles.
 */

(function () {
  'use strict';

  /* ================================================================ */
  /*  DOM References                                                   */
  /* ================================================================ */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Views
  const viewHome     = $('#view-home');
  const viewProgress = $('#view-progress');
  const viewDownload = $('#view-download');
  const viewError    = $('#view-error');

  // Clone form
  const urlInput  = $('#url-input');
  const cloneBtn  = $('#clone-btn');
  const cloneBtnText = $('#clone-btn-text');
  const cloneError = $('#clone-error');

  // Progress
  const progressUrl    = $('#progress-url');
  const progressBar    = $('#progress-bar');
  const progressPct    = $('#progress-pct');
  const progressAction = $('#progress-action');
  const statPages      = $('#stat-pages');
  const statAssets     = $('#stat-assets');
  const statFiles      = $('#stat-files');
  const statTime       = $('#stat-time');

  // Download
  const downloadUrl  = $('#download-url');
  const dlPages      = $('#dl-pages');
  const dlAssets     = $('#dl-assets');
  const dlSize       = $('#dl-size');
  const dlTime       = $('#dl-time');
  const downloadBtn  = $('#download-btn');
  const cloneAnother = $('#clone-another-btn');

  // Error
  const errorMessage  = $('#error-message');
  const errorRetryBtn = $('#error-retry-btn');

  // Nav
  const navToggle = $('#nav-toggle');
  const navLinks  = $('#navbar-links');

  /* ================================================================ */
  /*  View Management                                                  */
  /* ================================================================ */

  const views = [viewHome, viewProgress, viewDownload, viewError];

  function showView(view) {
    views.forEach((v) => {
      if (v) v.classList.remove('active');
    });
    if (view) view.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ================================================================ */
  /*  Mobile Nav Toggle                                                */
  /* ================================================================ */

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      navLinks.classList.toggle('open');
      navToggle.classList.toggle('open');
    });

    // Close nav when clicking a link
    navLinks.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('open');
        navToggle.classList.remove('open');
      });
    });
  }

  /* ================================================================ */
  /*  Clone Action                                                     */
  /* ================================================================ */

  let currentJobId = null;
  let pollInterval = null;

  function showError(msg) {
    if (!cloneError) return;
    cloneError.textContent = msg;
    cloneError.classList.add('visible');
  }

  function hideError() {
    if (!cloneError) return;
    cloneError.classList.remove('visible');
  }

  function setLoading(loading) {
    if (!cloneBtn || !cloneBtnText) return;
    if (loading) {
      cloneBtn.disabled = true;
      cloneBtnText.innerHTML = '<span class="spinner"></span>';
    } else {
      cloneBtn.disabled = false;
      cloneBtnText.textContent = 'Start Cloning';
    }
  }

  async function startClone() {
    hideError();
    let url = urlInput ? urlInput.value.trim() : '';

    if (!url) {
      showError('Please enter a website URL.');
      return;
    }

    // Auto-prepend https:// for bare domains (e.g. example.com, www.example.com)
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
      if (urlInput) urlInput.value = url;
    }

    // Basic client-side validation
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        showError('URL must start with http:// or https://');
        return;
      }
    } catch {
      showError('Please enter a valid URL (e.g. https://example.com)');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Something went wrong.');
        setLoading(false);
        return;
      }

      currentJobId = data.jobId;

      // Switch to progress view
      if (progressUrl) progressUrl.textContent = url;
      showView(viewProgress);
      setLoading(false);

      // Start polling
      startPolling();
    } catch (err) {
      showError('Network error. Please check your connection and try again.');
      setLoading(false);
    }
  }

  if (cloneBtn) {
    cloneBtn.addEventListener('click', startClone);
  }

  if (urlInput) {
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startClone();
    });
  }

  /* ================================================================ */
  /*  Progress Polling                                                 */
  /* ================================================================ */

  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(pollProgress, 800);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  async function pollProgress() {
    if (!currentJobId) return;

    try {
      const res = await fetch(`/api/progress/${currentJobId}`);
      const data = await res.json();

      if (!res.ok) {
        stopPolling();
        showErrorView(data.error || 'Job not found.');
        return;
      }

      // Update progress UI
      if (progressBar)    progressBar.style.width = data.progress + '%';
      if (progressPct)    progressPct.textContent = data.progress + '%';
      if (progressAction) progressAction.textContent = data.currentAction;
      if (statPages)      statPages.textContent = data.pagesFound;
      if (statAssets)     statAssets.textContent = data.assetsDownloaded;
      if (statFiles)      statFiles.textContent = data.filesProcessed;
      if (statTime)       statTime.textContent = data.elapsedTime;

      // Handle completion
      if (data.status === 'done') {
        stopPolling();
        showDownloadView(data);
      } else if (data.status === 'error') {
        stopPolling();
        showErrorView(data.error || 'An error occurred during cloning.');
      }
    } catch {
      // Network hiccup – keep trying
    }
  }

  /* ================================================================ */
  /*  Download View                                                    */
  /* ================================================================ */

  function showDownloadView(data) {
    if (downloadUrl)  downloadUrl.textContent = data.url;
    if (dlPages)      dlPages.textContent = data.pagesFound;
    if (dlAssets)     dlAssets.textContent = data.assetsDownloaded;
    if (dlSize)       dlSize.textContent = data.zipSize;
    if (dlTime)       dlTime.textContent = data.elapsedTime;
    if (downloadBtn)  downloadBtn.href = `/api/download/${currentJobId}`;
    showView(viewDownload);
  }

  /* ================================================================ */
  /*  Error View                                                       */
  /* ================================================================ */

  function showErrorView(msg) {
    if (errorMessage) errorMessage.textContent = msg;
    showView(viewError);
  }

  /* ================================================================ */
  /*  Navigation Buttons                                               */
  /* ================================================================ */

  if (cloneAnother) {
    cloneAnother.addEventListener('click', () => {
      currentJobId = null;
      if (urlInput) urlInput.value = '';
      showView(viewHome);
    });
  }

  if (errorRetryBtn) {
    errorRetryBtn.addEventListener('click', () => {
      currentJobId = null;
      showView(viewHome);
    });
  }

  // Nav CTA → scroll to clone input on home page
  const navCtaBtn = $('#nav-cta-btn');
  if (navCtaBtn) {
    navCtaBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showView(viewHome);
      setTimeout(() => {
        const el = $('#hero-clone');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (urlInput) urlInput.focus();
      }, 100);
    });
  }

  /* ================================================================ */
  /*  FAQ Accordion                                                    */
  /* ================================================================ */

  $$('.faq-question').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      if (!item) return;

      // Close all others
      $$('.faq-item').forEach((other) => {
        if (other !== item) other.classList.remove('open');
      });

      item.classList.toggle('open');
    });
  });

  /* ================================================================ */
  /*  Scroll Reveal                                                    */
  /* ================================================================ */

  function initScrollReveal() {
    const elements = $$('.reveal');
    if (!elements.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
    );

    elements.forEach((el) => observer.observe(el));
  }

  initScrollReveal();

  /* ================================================================ */
  /*  Floating Particles                                               */
  /* ================================================================ */

  function initParticles() {
    const canvas = document.getElementById('particles-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let particles = [];
    let animFrame;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    class Particle {
      constructor() {
        this.reset();
      }
      reset() {
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.size = Math.random() * 1.5 + 0.5;
        this.speedX = (Math.random() - 0.5) * 0.3;
        this.speedY = (Math.random() - 0.5) * 0.3;
        this.opacity = Math.random() * 0.3 + 0.05;
      }
      update() {
        this.x += this.speedX;
        this.y += this.speedY;
        if (this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) {
          this.reset();
        }
      }
      draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity})`;
        ctx.fill();
      }
    }

    // Create particles (less on mobile)
    const count = window.innerWidth < 768 ? 30 : 60;
    for (let i = 0; i < count; i++) {
      particles.push(new Particle());
    }

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p) => {
        p.update();
        p.draw();
      });
      animFrame = requestAnimationFrame(animate);
    }
    animate();
  }

  initParticles();

})();
