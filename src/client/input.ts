import { BTN } from '../shared/constants';

export class Input {
  private keys = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  private mouseDown = false;
  enabled = false;
  onToggle: ((code: string) => void) | null = null;
  onEscape: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !e.repeat) {
        e.preventDefault();
        this.onEscape?.();
        return;
      }
      if (!this.enabled) return;
      if (e.code === 'KeyP' && !e.repeat) this.onToggle?.(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      this.mouseX = e.offsetX;
      this.mouseY = e.offsetY;
    });
    canvas.addEventListener('pointerdown', (e) => {
      this.mouseX = e.offsetX;
      this.mouseY = e.offsetY;
      if (e.button === 0) this.mouseDown = true;
    });
    window.addEventListener('pointerup', () => (this.mouseDown = false));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  buttons(): number {
    if (!this.enabled) return 0;
    const k = this.keys;
    let b = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) b |= BTN.UP;
    if (k.has('KeyS') || k.has('ArrowDown')) b |= BTN.DOWN;
    if (k.has('KeyA') || k.has('ArrowLeft')) b |= BTN.LEFT;
    if (k.has('KeyD') || k.has('ArrowRight')) b |= BTN.RIGHT;
    if (this.mouseDown || k.has('Space')) b |= BTN.FIRE;
    return b;
  }
}
