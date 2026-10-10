/**
 * The open and close motion of every popup: CSS transitions on
 * Base UI's starting and ending styles, which a close can cancel midway, in
 * place of the keyframe utilities the registry expects from tw-animate-css.
 */

/** A popup fades and grows from its anchor over 150 ms. */
export const popupTransition =
  "origin-(--transform-origin) transition-[opacity,transform] duration-150 ease-out-quart data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

/** A backdrop fades over 150 ms. */
export const backdropTransition =
  "transition-opacity duration-150 ease-out data-starting-style:opacity-0 data-ending-style:opacity-0";

/** A dialog fades and settles from slightly small, 200 ms on an ease-out-quart curve. */
export const dialogTransition =
  "transition-[opacity,transform] duration-200 ease-out-quart data-starting-style:scale-[0.96] data-starting-style:opacity-0 data-ending-style:scale-[0.96] data-ending-style:opacity-0";
