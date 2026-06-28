// Scroll reveal
const revealEls = document.querySelectorAll('.reveal');
const revealObs = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('vis'); revealObs.unobserve(e.target); }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -48px 0px' });
revealEls.forEach(el => revealObs.observe(el));

// Nav bg on scroll
const nav = document.getElementById('mainNav');
window.addEventListener('scroll', () => {
  nav.style.background = window.scrollY > 60
    ? 'rgba(19,0,25,0.97)'
    : 'rgba(19,0,25,0.88)';
});

// Mobile drawer
function openDrawer()  { document.getElementById('navDrawer').classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeDrawer() { document.getElementById('navDrawer').classList.remove('open'); document.body.style.overflow = ''; }

// FAQ accordion
document.querySelectorAll('.faq-q').forEach(btn => {
  btn.addEventListener('click', () => {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    document.querySelectorAll('.faq-q').forEach(b => {
      b.setAttribute('aria-expanded', 'false');
      b.nextElementSibling.style.maxHeight = null;
    });
    if (!expanded) {
      btn.setAttribute('aria-expanded', 'true');
      btn.nextElementSibling.style.maxHeight = btn.nextElementSibling.scrollHeight + 'px';
    }
  });
});

// Contact form — HubSpot Forms API integration
const contactForm = document.getElementById('contactForm');
if (contactForm) {

  const whatsappInput = document.getElementById('cf-whatsapp');

  contactForm.addEventListener('submit', async function(e) {
    e.preventDefault();

    const submitBtn = contactForm.querySelector('.cf-submit');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando…';

    const nombre   = (contactForm.querySelector('#cf-name').value || '').trim();
    const email    = (contactForm.querySelector('#cf-email').value || '').trim();
    const empresa  = (contactForm.querySelector('#cf-empresa').value || '').trim();
    const desafio  = (contactForm.querySelector('#cf-desafio').value || '').trim();
    const viaChecked = [...contactForm.querySelectorAll('input[name="contacto_via"]:checked')];
    const via        = viaChecked.map(el => el.value).join(', ');

    if (!via) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
      contactForm.querySelector('input[name="contacto_via"]').setCustomValidity('Seleccioná al menos una opción.');
      contactForm.reportValidity();
      return;
    }
    contactForm.querySelectorAll('input[name="contacto_via"]').forEach(el => el.setCustomValidity(''));
    const whatsapp = (whatsappInput.value || '').trim();

    // Split nombre into firstname / lastname for HubSpot native fields
    const parts     = nombre.split(' ');
    const firstname = parts[0] || nombre;
    const lastname  = parts.slice(1).join(' ') || '';

    const fields = [
      { objectTypeId: '0-1', name: 'firstname',    value: firstname },
      { objectTypeId: '0-1', name: 'lastname',     value: lastname },
      { objectTypeId: '0-1', name: 'email',        value: email },
      { objectTypeId: '0-1', name: 'company',      value: empresa },
      { objectTypeId: '0-1', name: 'desafio',      value: desafio },
      { objectTypeId: '0-1', name: 'contacto_via', value: via }
    ];
    if (whatsapp) {
      fields.push({ objectTypeId: '0-1', name: 'hs_whatsapp_phone_number', value: whatsapp });
    }

    const payload = {
      fields,
      context: {
        pageUri:  window.location.href,
        pageName: document.title
      }
    };

    const PORTAL_ID = '51671122';
    const FORM_GUID = '18bcb1bd-cf18-4512-bb18-09ac783b0e59';
    const endpoint  = `https://api.hsforms.com/submissions/v3/integration/submit/${PORTAL_ID}/${FORM_GUID}`;

    try {
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }

      // Success
      contactForm.hidden = true;
      document.getElementById('cfConfirm').hidden = false;

      // GA4 — generate_lead (conversión primaria)
      if (typeof gtag === 'function') {
        gtag('event', 'generate_lead', { form_id: 'contacto_rio' });
      }

    } catch (err) {
      console.error('HubSpot form error:', err);
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
      const errorEl = contactForm.querySelector('.cf-error');
      if (errorEl) {
        errorEl.hidden = false;
      } else {
        alert('Hubo un problema al enviar tu consulta. Por favor intentá nuevamente o escribinos directamente a hola@rioimpulsodigital.com');
      }
    }
  });
}

// GA4 — contact_click (conversión secundaria · solo email por ahora)
const emailLink = document.querySelector('a[href="mailto:hola@rioimpulsodigital.com"]');
if (emailLink) {
  emailLink.addEventListener('click', () => {
    if (typeof gtag === 'function') {
      gtag('event', 'contact_click', { contact_method: 'email' });
    }
  });
}

// GA4 — cta_click (engagement · tres líneas de negocio)
document.querySelectorAll('.line-cta').forEach(btn => {
  btn.addEventListener('click', () => {
    if (typeof gtag === 'function') {
      const text = btn.textContent.trim();
      let ctaId = 'unknown';
      if (text.includes('automatizar'))  ctaId = 'estandarizada';
      else if (text.includes('medida'))  ctaId = 'medida';
      else if (text.includes('diagn'))   ctaId = 'consultoria';
      gtag('event', 'cta_click', { cta_id: ctaId, cta_text: text });
    }
  });
});
