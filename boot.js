(async function boot(){
  const remembered = await tryRememberedSession();
  if(remembered){
    proceedAfterAuth(remembered);
  } else {
    showPinOverlay((role)=> proceedAfterAuth(role));
  }
})();
