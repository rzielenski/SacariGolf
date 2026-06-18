// Minimal ambient types for react-native-qrcode-svg (ships no TS declarations).
declare module 'react-native-qrcode-svg' {
  import { Component } from 'react';
  export interface QRCodeProps {
    value?: string;
    size?: number;
    color?: string;
    backgroundColor?: string;
    quietZone?: number;
    ecl?: 'L' | 'M' | 'Q' | 'H';
    logo?: any;
    logoSize?: number;
    logoBackgroundColor?: string;
    logoMargin?: number;
    logoBorderRadius?: number;
    getRef?: (ref: any) => void;
    onError?: (error: any) => void;
  }
  export default class QRCode extends Component<QRCodeProps> {}
}
