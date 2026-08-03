const properties = [
  {
    id: 1,
    title: 'Modern Family Home',
    type: 'House',
    price: 450000,
    location: 'Beverly Hills, CA',
    beds: 4,
    baths: 3,
    sqft: 2800,
    img: 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=600&q=80',
    purpose: 'for-sale',
  },
  {
    id: 2,
    title: 'Luxury Downtown Apartment',
    type: 'Apartment',
    price: 2500,
    location: 'New York, NY',
    beds: 2,
    baths: 2,
    sqft: 1100,
    img: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=80',
    purpose: 'for-rent',
  },
  {
    id: 3,
    title: 'Beachfront Villa',
    type: 'Villa',
    price: 1200000,
    location: 'Malibu, CA',
    beds: 5,
    baths: 4,
    sqft: 4200,
    img: 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=600&q=80',
    purpose: 'for-sale',
  },
  {
    id: 4,
    title: 'Cozy Suburban Condo',
    type: 'Condo',
    price: 320000,
    location: 'Austin, TX',
    beds: 2,
    baths: 1,
    sqft: 950,
    img: 'https://images.unsplash.com/photo-1574362848149-11496d93a7c7?w=600&q=80',
    purpose: 'for-sale',
  },
  {
    id: 5,
    title: 'Penthouse with View',
    type: 'Apartment',
    price: 3500,
    location: 'Miami, FL',
    beds: 3,
    baths: 2,
    sqft: 1500,
    img: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=600&q=80',
    purpose: 'for-rent',
  },
  {
    id: 6,
    title: 'Colonial Estate',
    type: 'House',
    price: 890000,
    location: 'Greenwich, CT',
    beds: 5,
    baths: 4,
    sqft: 3800,
    img: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=600&q=80',
    purpose: 'for-sale',
  },
  {
    id: 7,
    title: 'Modern Loft Space',
    type: 'Condo',
    price: 1800,
    location: 'San Francisco, CA',
    beds: 1,
    baths: 1,
    sqft: 800,
    img: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=600&q=80',
    purpose: 'for-rent',
  },
  {
    id: 8,
    title: 'Mediterranean Villa',
    type: 'Villa',
    price: 2100000,
    location: 'Santa Barbara, CA',
    beds: 6,
    baths: 5,
    sqft: 5200,
    img: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=600&q=80',
    purpose: 'for-sale',
  },
  {
    id: 9,
    title: 'Charming Craftsman Home',
    type: 'House',
    price: 525000,
    location: 'Portland, OR',
    beds: 3,
    baths: 2,
    sqft: 1900,
    img: 'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=600&q=80',
    purpose: 'for-sale',
  },
];

function formatPrice(price, purpose) {
  if (purpose === 'for-rent') {
    return `$${price.toLocaleString()}/mo`;
  }
  return `$${price.toLocaleString()}`;
}

function createPropertyCard(property) {
  const div = document.createElement('div');
  div.className = 'property-card';
  div.dataset.type = property.type;
  div.dataset.price = property.price;
  div.innerHTML = `
    <div class="card-image">
      <img src="${property.img}" alt="${property.title}" loading="lazy" />
      <span class="card-badge ${property.purpose}">${property.purpose === 'for-sale' ? 'For Sale' : 'For Rent'}</span>
      <button class="card-wishlist" onclick="toggleWishlist(this)" aria-label="Add to wishlist">
        <i class="far fa-heart"></i>
      </button>
    </div>
    <div class="card-body">
      <div class="card-price">${formatPrice(property.price, property.purpose)}</div>
      <h3 class="card-title">${property.title}</h3>
      <div class="card-location"><i class="fas fa-map-marker-alt"></i> ${property.location}</div>
      <div class="card-features">
        <span><i class="fas fa-bed"></i> ${property.beds} Beds</span>
        <span><i class="fas fa-bath"></i> ${property.baths} Baths</span>
        <span><i class="fas fa-ruler-combined"></i> ${property.sqft.toLocaleString()} sqft</span>
      </div>
    </div>
  `;
  return div;
}

function renderProperties(filteredProperties) {
  const grid = document.getElementById('propertyGrid');
  grid.innerHTML = '';
  filteredProperties.forEach((p, i) => {
    const card = createPropertyCard(p);
    card.style.animationDelay = `${i * 0.1}s`;
    grid.appendChild(card);
  });
}

function filterProperties() {
  const location = document.getElementById('searchLocation').value.toLowerCase();
  const type = document.getElementById('propertyType').value;
  const priceRange = document.getElementById('priceRange').value;

  const filtered = properties.filter((p) => {
    const matchLocation = !location || p.location.toLowerCase().includes(location);
    const matchType = !type || p.type === type;
    let matchPrice = true;
    if (priceRange) {
      const [min, max] = priceRange.split('-').map(Number);
      matchPrice = p.price >= min && p.price <= max;
    }
    return matchLocation && matchType && matchPrice;
  });

  renderProperties(filtered);

  if (filtered.length === 0) {
    document.getElementById('propertyGrid').innerHTML =
      '<p class="no-results">No properties match your criteria. Try a different search.</p>';
  }
}

document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const filter = btn.dataset.filter;
    const filtered = filter === 'all' ? properties : properties.filter((p) => p.type === filter);
    renderProperties(filtered);
  });
});

function toggleWishlist(btn) {
  btn.classList.toggle('liked');
  const icon = btn.querySelector('i');
  if (btn.classList.contains('liked')) {
    icon.className = 'fas fa-heart';
    showToast('Added to wishlist!');
  } else {
    icon.className = 'far fa-heart';
    showToast('Removed from wishlist.');
  }
}

let toastTimeout;

function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  clearTimeout(toastTimeout);

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 2000);
}

// Counter animation
function animateCounters() {
  const nums = document.querySelectorAll('.num');
  nums.forEach((num) => {
    const target = parseInt(num.dataset.target);
    const duration = 2000;
    const step = Math.ceil(target / (duration / 16));
    let current = 0;

    const update = () => {
      current += step;
      if (current >= target) {
        num.textContent = target.toLocaleString();
        return;
      }
      num.textContent = current.toLocaleString();
      requestAnimationFrame(update);
    };

    update();
  });
}

// Header scroll
function handleScroll() {
  const header = document.querySelector('.header');
  header.classList.toggle('scrolled', window.scrollY > 50);

  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-link');

  let current = '';
  sections.forEach((section) => {
    const top = section.offsetTop - 150;
    if (window.scrollY >= top) {
      current = section.getAttribute('id');
    }
  });

  navLinks.forEach((link) => {
    link.classList.toggle('active', link.getAttribute('href') === `#${current}`);
  });
}

// Mobile menu
function initMobileMenu() {
  const hamburger = document.getElementById('hamburger');
  const nav = document.querySelector('.nav');

  hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('active');
    nav.classList.toggle('open');
  });

  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', () => {
      hamburger.classList.remove('active');
      nav.classList.remove('open');
    });
  });
}

// Contact form
function initContactForm() {
  const form = document.getElementById('contactForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    showToast('Message sent! We\'ll get back to you soon.');
    form.reset();
  });
}

// Newsletter
function initNewsletter() {
  const form = document.querySelector('.newsletter-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    showToast('Subscribed to newsletter!');
    form.reset();
  });
}

// Intersection Observer for counters
function initCounterObserver() {
  const stats = document.querySelector('.hero-stats');
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          animateCounters();
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.5 }
  );
  observer.observe(stats);
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  renderProperties(properties);
  handleScroll();
  initMobileMenu();
  initContactForm();
  initNewsletter();
  initCounterObserver();
  window.addEventListener('scroll', handleScroll);
});
