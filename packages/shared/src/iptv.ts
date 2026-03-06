export type TIptvChannel = {
  name: string;
  url: string;
  logo?: string;
  group?: string;
};

export type TIptvStatus = {
  status: 'idle' | 'starting' | 'streaming' | 'error';
  activeChannel?: {
    index: number;
    name: string;
    logo?: string;
  };
  error?: string;
};
