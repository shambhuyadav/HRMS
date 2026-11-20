// A long list keeps its column headings in view while the page scrolls (styles.css makes the heading cells sticky). A card whose table
// is wider than the card scrolls sideways, and a box that scrolls would hold the headings inside itself rather than at the top of the
// page: so only a card whose content fits is marked data-fit, and only there do the headings stick. Re-checked as pages render and as
// the window changes size (App.tsx); a card whose content grows past its width loses the mark and scrolls sideways as before.

/** Marks, under `root`, each card holding a table with a heading row whose content fits its width; clears the mark elsewhere. */
export function markFittingCards(root: HTMLElement): void {
  for (const card of root.querySelectorAll<HTMLElement>('.card')) {
    const fits = card.querySelector('table > thead') !== null && card.scrollWidth <= card.clientWidth + 1;
    if (fits !== card.hasAttribute('data-fit')) card.toggleAttribute('data-fit', fits);
  }
}
