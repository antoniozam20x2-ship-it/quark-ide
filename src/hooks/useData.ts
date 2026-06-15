import { useState, useEffect } from 'react';

interface Data {
  message: string;
}

const useData = () => {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        // In a real app, you would fetch data from an API
        await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate network delay
        const mockData: Data = {
          message: 'Welcome to the Calculator!'
        };
        setData(mockData);
      } catch (err) {
        setError('Failed to fetch data.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  return { data, loading, error };
};

export default useData;
