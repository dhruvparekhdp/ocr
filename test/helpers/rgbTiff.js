/**
 * Uncompressed little-endian RGB TIFF, used only so tests can upload a real
 * TIFF without adding an image library. Photometric RGB, one strip.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgb width * height * 3 bytes, row-major
 * @returns {Buffer}
 */
export const encodeRgbTiff = (width, height, rgb) => {
  if (rgb.length !== width * height * 3) {
    throw new Error('RGB buffer length does not match width and height');
  }
  const tags = [
    [256, 3, 1, width],
    [257, 3, 1, height],
    [258, 3, 3, 0],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, 0],
    [277, 3, 1, 3],
    [278, 4, 1, height],
    [279, 4, 1, rgb.length],
  ];
  const ifdOffset = 8;
  const bitsOffset = ifdOffset + 2 + tags.length * 12 + 4;
  const stripOffset = bitsOffset + 6;
  tags[2][3] = bitsOffset;
  tags[5][3] = stripOffset;

  const header = Buffer.alloc(stripOffset);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(ifdOffset, 4);
  header.writeUInt16LE(tags.length, ifdOffset);
  tags.forEach((tag, index) => {
    const at = ifdOffset + 2 + index * 12;
    header.writeUInt16LE(tag[0], at);
    header.writeUInt16LE(tag[1], at + 2);
    header.writeUInt32LE(tag[2], at + 4);
    if (tag[1] === 3 && tag[2] === 1) header.writeUInt16LE(tag[3], at + 8);
    else header.writeUInt32LE(tag[3], at + 8);
  });
  header.writeUInt16LE(8, bitsOffset);
  header.writeUInt16LE(8, bitsOffset + 2);
  header.writeUInt16LE(8, bitsOffset + 4);
  return Buffer.concat([header, rgb]);
};
