/* script.js
 * modernizr checks mainly
 */
window.onload = function() {

	if (Modernizr.svg) {
		console.log('svg');
	} else {
		var mail = document.getElementById('mail');
		var github = document.getElementById('github');
		var linkedin = document.getElementById('linkedin');
		var stackoverflow = document.getElementById('stackoverflow');

		mail.src = 'assets/images/' + mail + '.png';
		github.src = 'assets/images/' + github + '.png';
		linkedin.src = 'assets/images/' + linkedin + '.png';
		stackoverflow.src = 'assets/images/' + stackoverflow + '.png';
	}
}
