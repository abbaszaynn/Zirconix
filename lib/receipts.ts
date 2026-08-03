import * as ImageManipulator from 'expo-image-manipulator';
import { File } from 'expo-file-system';

import { supabase } from './supabase';

/**
 * Receipt capture → compression → upload.
 *
 * The free tier gives 1 GB of object storage. Eight directors photographing
 * receipts on modern phones produce 3–6 MB files; at that size the pilot would
 * exhaust the allowance in a few hundred receipts. Resizing the long edge to
 * 1600px at 70% JPEG lands around 150–400 KB and is still comfortably legible
 * for a printed till receipt — which is the whole point of keeping it.
 *
 * Compression happens on the device, before upload, so an expensive image never
 * crosses the network at all.
 */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.7;

export type PreparedReceipt = {
  uri: string;
  mimeType: string;
  byteSize: number;
  kind: 'receipt_photo' | 'receipt_pdf' | 'payment_confirmation';
};

export async function compressImage(
  uri: string,
  kind: PreparedReceipt['kind'] = 'receipt_photo',
): Promise<PreparedReceipt> {
  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  context.resize({ width: MAX_EDGE });

  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    compress: JPEG_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  return {
    uri: result.uri,
    mimeType: 'image/jpeg',
    byteSize: new File(result.uri).size ?? 0,
    kind,
  };
}

/**
 * Object key layout is '<entity_id>/<year>/<uuid>.<ext>'. The storage RLS policy
 * reads the entity out of the first segment, so this shape is load-bearing —
 * changing it changes who can read the file.
 */
export function receiptPath(entityId: string, extension: string): string {
  const year = new Date().getFullYear();
  return `${entityId}/${year}/${globalThis.crypto.randomUUID()}.${extension}`;
}

export async function uploadReceipt(
  entityId: string,
  receipt: PreparedReceipt,
): Promise<{ storage_path: string; kind: string; mime_type: string; byte_size: number }> {
  const extension = receipt.mimeType === 'application/pdf' ? 'pdf' : 'jpg';
  const path = receiptPath(entityId, extension);

  // Read the bytes directly. Passing a file:// URI to fetch and then to Storage
  // is unreliable on Android; expo-file-system's File implements Blob, so this
  // hands Storage a real buffer.
  const bytes = await new File(receipt.uri).arrayBuffer();

  const { error } = await supabase.storage.from('receipts').upload(path, bytes, {
    contentType: receipt.mimeType,
    upsert: false,
  });
  if (error) throw error;

  return {
    storage_path: path,
    kind: receipt.kind,
    mime_type: receipt.mimeType,
    byte_size: receipt.byteSize || bytes.byteLength,
  };
}

/**
 * Receipts live in a private bucket. Viewing one needs a short-lived signed URL;
 * ten minutes is long enough to look at it and short enough that a URL pasted
 * into a chat is useless by the time anyone else opens it.
 */
export async function signedReceiptUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('receipts').createSignedUrl(path, 600);
  if (error) throw error;
  return data.signedUrl;
}
