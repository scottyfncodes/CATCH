// Best-effort impact haptics. Android/Chrome: Vibration API. iOS Safari has no
// Vibration API; Safari 18+ gives a light system tap when a native switch
// control toggles, which we use as a progressive enhancement. Nothing in the
// game depends on haptics.

import { prefs } from './storage';

let label: HTMLLabelElement | null = null;

function iosSwitch() {
  if (!label) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.id = 'catch-haptic';
    input.style.display = 'none';
    label = document.createElement('label');
    label.htmlFor = input.id;
    label.style.display = 'none';
    label.setAttribute('aria-hidden', 'true');
    document.body.append(input, label);
  }
  label.click();
}

export function haptic(strength: 'light' | 'firm' = 'light') {
  if (!prefs().haptics) return;
  try {
    if ('vibrate' in navigator && typeof navigator.vibrate === 'function') {
      navigator.vibrate(strength === 'firm' ? 22 : 10);
      return;
    }
    iosSwitch();
  } catch { /* ignore */ }
}
