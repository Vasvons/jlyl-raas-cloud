'use client';

import { redirect } from 'next/navigation';
import { useEffect } from 'react';

export default function Home() {
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      redirect('/dashboard');
    } else {
      redirect('/login');
    }
  }, []);
  return null;
}
