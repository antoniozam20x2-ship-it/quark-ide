import { useState, useEffect } from 'react';

export const useData = <T>(initialData: T) => {
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    setLoading(true);
    setTimeout(() => setLoading(false), 500);
  }, [data]);

  return { data, loading, setData };
};