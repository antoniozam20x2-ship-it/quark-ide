import React, { useState } from 'react';

const App: React.FC = () => {
  const [input, setInput] = useState<string>('');
  const [result, setResult] = useState<string>('');

  const handleButtonClick = (value: string) => {
    if (value === '=') {
      try {
        setResult(eval(input).toString());
      } catch (error) {
        setResult('Error');
      }
    } else if (value === 'C') {
      setInput('');
      setResult('');
    } else {
      setInput(input + value);
    }
  };

  const buttonStyle: React.CSSProperties = {
    padding: '20px',
    fontSize: '1.5em',
    border: '1px solid #ccc',
    borderRadius: '5px',
    cursor: 'pointer',
    backgroundColor: '#f0f0f0',
    margin: '5px',
    flex: '1',
    minWidth: '60px'
  };

  const inputStyle: React.CSSProperties = {
    padding: '20px',
    fontSize: '2em',
    border: '1px solid #ccc',
    borderRadius: '5px',
    marginBottom: '10px',
    textAlign: 'right'
  };

  const resultStyle: React.CSSProperties = {
    padding: '20px',
    fontSize: '2em',
    border: '1px solid #ccc',
    borderRadius: '5px',
    marginBottom: '20px',
    textAlign: 'right',
    backgroundColor: '#e0e0e0'
  };

  const buttonRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'center'
  };

  const calculatorStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '20px',
    border: '2px solid #333',
    borderRadius: '10px',
    backgroundColor: '#ddd'
  };

  return (
    <div style={calculatorStyle}>
      <input type="text" value={input} style={inputStyle} readOnly />
      <div style={resultStyle}>{result}</div>
      <div style={buttonRowStyle}>
        <button onClick={() => handleButtonClick('7')} style={buttonStyle}>7</button>
        <button onClick={() => handleButtonClick('8')} style={buttonStyle}>8</button>
        <button onClick={() => handleButtonClick('9')} style={buttonStyle}>9</button>
        <button onClick={() => handleButtonClick('/')} style={buttonStyle}>/</button>
      </div>
      <div style={buttonRowStyle}>
        <button onClick={() => handleButtonClick('4')} style={buttonStyle}>4</button>
        <button onClick={() => handleButtonClick('5')} style={buttonStyle}>5</button>
        <button onClick={() => handleButtonClick('6')} style={buttonStyle}>6</button>
        <button onClick={() => handleButtonClick('*')} style={buttonStyle}>*</button>
      </div>
      <div style={buttonRowStyle}>
        <button onClick={() => handleButtonClick('1')} style={buttonStyle}>1</button>
        <button onClick={() => handleButtonClick('2')} style={buttonStyle}>2</button>
        <button onClick={() => handleButtonClick('3')} style={buttonStyle}>3</button>
        <button onClick={() => handleButtonClick('-')} style={buttonStyle}>-</button>
      </div>
      <div style={buttonRowStyle}>
        <button onClick={() => handleButtonClick('0')} style={buttonStyle}>0</button>
        <button onClick={() => handleButtonClick('.')} style={buttonStyle}>.</button>
        <button onClick={() => handleButtonClick('+')} style={buttonStyle}>+</button>
        <button onClick={() => handleButtonClick('=')} style={buttonStyle}>=</button>
      </div>
      <div style={buttonRowStyle}>
        <button onClick={() => handleButtonClick('C')} style={{ ...buttonStyle, backgroundColor: '#f44336', color: 'white', flex: '2' }}>C</button>
      </div>
    </div>
  );
};

export default App;
