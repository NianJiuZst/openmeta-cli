const OPENMETA_WORDMARK_LINES = String.raw`
    ___  ____  _____ _   _ __  __ _____ _____  _    
  / _ \|  _ \| ____| \ | |  \/  | ____|_   _|/ \   
 | | | | |_) |  _| |  \| | |\/| |  _|   | | / _ \  
 | |_| |  __/| |___| |\  | |  | | |___  | |/ ___ \ 
  \___/|_|   |_____|_| \_|_|  |_|_____| |_/_/   \_\
                                                   
`
	.slice(1)
	.trimEnd()
	.split("\n");

export function getOpenMetaWordmarkLines(): string[] {
	return [...OPENMETA_WORDMARK_LINES];
}
