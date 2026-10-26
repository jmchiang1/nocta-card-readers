// SPDX-License-Identifier: GPL-3.0-only
/* nocta-card-readers — the one error a reader throws: 'not-this-machine' when
 * the files aren't its machine's card. Copyright (C) 2026 Nocta. GPL-3.0. */
export class ReaderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
