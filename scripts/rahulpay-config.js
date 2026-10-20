// Sudo: /scripts/rahulpay-config.js
// Test publishable key ID for Razorpay checkout.
//
// PASTE YOUR OWN KEY HERE before you enable payments:
//   development/testing:  rzp_test_<...>
//   production live:      rzp_live_<...>
//
// The secret key stays on your backend and is never used in this client script.
//
(function () {
  if (typeof window === "undefined") return;
  window.Razorpay = window.Razorpay || {};
  window.Razorpay.testKeyId = "rzp_test_TpjbsTfAoTQsBY";
})();
