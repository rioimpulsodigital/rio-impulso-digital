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
