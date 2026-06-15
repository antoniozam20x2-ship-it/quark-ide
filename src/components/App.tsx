import React, { useState } from 'react';

interface Product {
  id: number;
  name: string;
  price: string;
  color: string;
}

const products: Product[] = [
  { id: 1, name: 'NEON RUNNER v1', price: '299 CR', color: '#0ff' },
  { id: 2, name: 'VOID WALKER', price: '450 CR', color: '#f0f' },
  { id: 3, name: 'CYBER TREADS', price: '180 CR', color: '#0f0' },
  { id: 4, name: 'PHANTOM SOLE', price: '320 CR', color: '#f00' }
];

export const App: React.FC = () => {
  return (
    <div style={{ backgroundColor: '#0a0a0a', color: '#fff', minHeight: '100vh', padding: '40px', fontFamily: 'monospace' }}>
      <h1 style={{ borderLeft: '5px solid #0ff', paddingLeft: '10px' }}>QUARK // SNEAKER GRID</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginTop: '40px' }}>
        {products.map((p) => (
          <div key={p.id} style={{ border: `1px solid ${p.color}`, padding: '20px', textAlign: 'center', boxShadow: `0 0 10px ${p.color}44` }}>
            <h3 style={{ color: p.color }}>{p.name}</h3>
            <p>{p.price}</p>
            <button style={{ background: 'transparent', color: '#fff', border: '1px solid #fff', cursor: 'pointer' }}>SYNC</button>
          </div>
        ))}
      </div>
    </div>
  );
};