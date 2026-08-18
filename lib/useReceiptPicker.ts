import { useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

import { compressImage, preparePdf, type PreparedReceipt } from './receipts';
import { humanError } from './format';

export function useReceiptPicker() {
  const [receipt, setReceipt] = useState<PreparedReceipt | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickReceipt(source: 'camera' | 'library') {
    setError(null);
    try {
      const permission =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        setError(
          source === 'camera'
            ? 'Camera access is needed to photograph a receipt.'
            : 'Photo access is needed to attach an existing receipt.',
        );
        return;
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ quality: 1, mediaTypes: ['images'] })
          : await ImagePicker.launchImageLibraryAsync({ quality: 1, mediaTypes: ['images'] });

      if (result.canceled || !result.assets[0]) return;

      setPreparing(true);
      const prepared = await compressImage(
        result.assets[0].uri,
        source === 'camera' ? 'receipt_photo' : 'payment_confirmation',
      );
      setReceipt(prepared);
      return prepared;
    } catch (e) {
      setError(humanError(e));
      return null;
    } finally {
      setPreparing(false);
    }
  }

  async function pickFiles() {
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/jpeg', 'image/png', 'application/pdf'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return null;

      const asset = result.assets[0];
      setPreparing(true);
      let prepared: PreparedReceipt;
      if (asset.mimeType === 'application/pdf' || asset.name?.toLowerCase().endsWith('.pdf')) {
        prepared = await preparePdf(asset.uri, asset.size ?? undefined);
      } else {
        prepared = await compressImage(asset.uri, 'payment_confirmation');
      }
      setReceipt(prepared);
      return prepared;
    } catch (e) {
      setError(humanError(e));
      return null;
    } finally {
      setPreparing(false);
    }
  }

  function promptUpload(onSelect?: (receipt: PreparedReceipt) => void) {
    if (Platform.OS === 'web') {
      const wantCamera = window.confirm('Use Camera? (Click Cancel to choose files)');
      if (wantCamera) {
        pickReceipt('camera').then((r) => r && onSelect?.(r));
      } else {
        pickFiles().then((r) => r && onSelect?.(r));
      }
      return;
    }

    Alert.alert('Uploads', 'Choose a source for your receipt', [
      { text: 'Camera', onPress: () => pickReceipt('camera').then((r) => r && onSelect?.(r)) },
      { text: 'Files', onPress: () => pickFiles().then((r) => r && onSelect?.(r)) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  return {
    receipt,
    setReceipt,
    preparing,
    error,
    setError,
    promptUpload,
  };
}
