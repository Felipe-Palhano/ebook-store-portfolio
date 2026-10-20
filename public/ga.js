// Cole aqui o ID de medição do Google Analytics (começa com G-)
var GA_ID = 'G-QGSYWJ77EK';

window.dataLayer = window.dataLayer || [];
function gtag(){ dataLayer.push(arguments); }
if (/^G-[A-Z0-9]{6,}$/.test(GA_ID) && GA_ID !== 'G-XXXXXXXXXX') {
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);
  gtag('js', new Date());
  gtag('config', GA_ID);
}
